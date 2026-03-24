import oss from 'ali-oss'
import chalk from 'chalk'
import cliProgress from 'cli-progress'
import { globSync } from 'glob'
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { normalizePath, Plugin, type ResolvedConfig } from 'vite'
import type { ManifestPayload, UploadResult, UploadTask, vitePluginDeployOssOption } from './types'
import { getFileMd5, removeEmptyDirectories } from './utils/file'
import {
  ensureTrailingSlash,
  normalizeObjectKey,
  normalizePathSegments,
  normalizeUrlLikeBase,
  resolveManifestFileName,
  resolveUploadedFileUrl,
} from './utils/path'
import { formatBytes, formatDuration } from './utils/progress'
import { getLogSymbol, renderInlineStats, renderPanel, truncateTerminalText } from './utils/terminal'
export type {
  ManifestConfig,
  ManifestFileItem,
  ManifestOption,
  ManifestPayload,
  UploadResult,
  UploadTask,
  vitePluginDeployOssOption,
} from './types'

const createManifestPayload = async (
  results: UploadResult[],
  configBase?: string,
  alias?: string,
): Promise<ManifestPayload> => {
  const successfulResults = results.filter((result) => result.success)

  const files = await Promise.all(
    successfulResults.map(async (result) => {
      const md5 = await getFileMd5(result.file)
      return {
        file: result.relativeFilePath,
        key: result.name,
        url: resolveUploadedFileUrl(result.relativeFilePath, result.name, configBase, alias),
        md5,
      }
    }),
  )

  return {
    version: Date.now(),
    files,
  }
}

export default function vitePluginDeployOss(option: vitePluginDeployOssOption): Plugin {
  const {
    accessKeyId,
    accessKeySecret,
    region,
    bucket,
    configBase,
    skip = '**/index.html',
    uploadDir,
    overwrite = true,
    secure = true,
    autoDelete = false,
    alias,
    open = true,
    fancy = true,
    noCache = false,
    failOnError = true,
    concurrency = 5,
    retryTimes = 3,
    multipartThreshold = 10 * 1024 * 1024,
    manifest = false,
    ...props
  } = option || {}

  const normalizedUploadDir = normalizePathSegments(uploadDir)
  const normalizedConfigBase = configBase ? ensureTrailingSlash(normalizeUrlLikeBase(configBase)) : undefined
  const normalizedAlias = alias ? normalizeUrlLikeBase(alias) : undefined

  let buildFailed = false

  let upload = false
  let outDir = normalizePath(resolve('dist'))
  let resolvedConfig: ResolvedConfig | null = null
  const useInteractiveOutput =
    fancy && Boolean(process.stdout?.isTTY) && Boolean(process.stderr?.isTTY) && !process.env.CI
  const clearViewport = () => {
    if (!useInteractiveOutput) return
    process.stdout.write('\x1b[2J\x1b[0f')
  }

  const validateOptions = (): string[] => {
    const errors: string[] = []
    if (!accessKeyId) errors.push('accessKeyId is required')
    if (!accessKeySecret) errors.push('accessKeySecret is required')
    if (!bucket) errors.push('bucket is required')
    if (!region) errors.push('region is required')
    if (!uploadDir) errors.push('uploadDir is required')
    if (!Number.isInteger(retryTimes) || retryTimes < 1) errors.push('retryTimes must be >= 1')
    if (!Number.isInteger(concurrency) || concurrency < 1) errors.push('concurrency must be >= 1')
    if (!Number.isFinite(multipartThreshold) || multipartThreshold <= 0) errors.push('multipartThreshold must be > 0')
    return errors
  }

  const uploadSingleTask = async (client: oss, task: UploadTask): Promise<UploadResult> =>
    uploadFileWithRetry(client, task, false)

  const uploadFileWithRetry = async (
    client: oss,
    task: UploadTask,
    silentLogs: boolean,
    maxRetries: number = retryTimes,
  ): Promise<UploadResult> => {
    const shouldUseMultipart = task.size >= multipartThreshold
    const headers = {
      'x-oss-storage-class': 'Standard',
      'x-oss-object-acl': 'default',
      'Cache-Control':
        task.cacheControl || (noCache || task.name.endsWith('.html') ? 'no-cache' : 'public, max-age=86400, immutable'),
      'x-oss-forbid-overwrite': overwrite ? 'false' : 'true',
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = shouldUseMultipart
          ? await client.multipartUpload(task.name, task.filePath, {
              timeout: 600000,
              partSize: 1024 * 1024,
              parallel: Math.max(1, Math.min(concurrency, 4)),
              headers,
            })
          : await client.put(task.name, task.filePath, {
              timeout: 600000,
              headers,
            })

        if (result.res.status === 200) {
          if (autoDelete) {
            try {
              await unlink(task.filePath)
            } catch (error) {
              console.warn(
                `${getLogSymbol('warning')} 删除本地文件失败: ${truncateTerminalText(task.relativeFilePath, 18)}`,
              )
            }
          }

          return {
            success: true,
            file: task.filePath,
            relativeFilePath: task.relativeFilePath,
            name: task.name,
            size: task.size,
            retries: attempt - 1,
          }
        } else {
          throw new Error(`Upload failed with status: ${result.res.status}`)
        }
      } catch (error) {
        if (attempt === maxRetries) {
          if (!silentLogs) {
            const reason = error instanceof Error ? error.message : String(error)
            console.log(`${getLogSymbol('danger')} ${truncateTerminalText(task.relativeFilePath, 18)}  ${reason}`)
          }
          return {
            success: false,
            file: task.filePath,
            relativeFilePath: task.relativeFilePath,
            name: task.name,
            size: task.size,
            retries: attempt - 1,
            error: error as Error,
          }
        } else {
          if (!silentLogs) {
            console.log(
              `${getLogSymbol('warning')} ${truncateTerminalText(task.relativeFilePath, 18)}  正在重试 (${attempt}/${maxRetries})`,
            )
          }
          // 等待一段时间再重试
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
        }
      }
    }

    return {
      success: false,
      file: task.filePath,
      relativeFilePath: task.relativeFilePath,
      name: task.name,
      size: task.size,
      retries: maxRetries,
      error: new Error('Max retries exceeded'),
    }
  }

  const uploadFilesInBatches = async (
    client: oss,
    files: string[],
    windowSize: number = concurrency,
  ): Promise<UploadResult[]> => {
    const results: UploadResult[] = []
    const totalFiles = files.length
    const tasks: UploadTask[] = []
    let completed = 0
    let failed = 0
    let uploadedBytes = 0
    let retries = 0

    const taskCandidates = await Promise.all(
      files.map(async (relativeFilePath) => {
        const filePath = normalizePath(resolve(outDir, relativeFilePath))
        const name = normalizeObjectKey(normalizedUploadDir, relativeFilePath)

        try {
          const fileStats = await stat(filePath)
          return { task: { filePath, relativeFilePath, name, size: fileStats.size } as UploadTask }
        } catch (error) {
          return { task: null, error: error as Error, filePath, relativeFilePath, name }
        }
      }),
    )

    for (const candidate of taskCandidates) {
      if (candidate.task) {
        tasks.push(candidate.task)
      } else {
        failed++
        completed++
        results.push({
          success: false,
          file: candidate.filePath,
          relativeFilePath: candidate.relativeFilePath,
          name: candidate.name,
          size: 0,
          retries: 0,
          error: candidate.error,
        })
      }
    }

    const totalBytes = tasks.reduce((sum, task) => sum + task.size, 0)
    const startAt = Date.now()
    const safeWindowSize = Math.max(1, Math.min(windowSize, tasks.length || 1))
    const silentLogs = Boolean(useInteractiveOutput)

    const progressBar = useInteractiveOutput
      ? new cliProgress.SingleBar({
          hideCursor: true,
          clearOnComplete: true,
          stopOnComplete: true,
          barsize: 18,
          barCompleteChar: '█',
          barIncompleteChar: '░',
          format: `${chalk.gray('上传')} ${chalk.bold('{percentage}%')} ${chalk.cyan('{bar}')} ${chalk.gray('·')} ${chalk.magenta('{speed}/s')} ${chalk.gray('·')} ${chalk.gray('{elapsed}')}s`,
        })
      : null
    const reportEvery = Math.max(1, Math.ceil(totalFiles / 6))
    let lastReportedCompleted = -1

    if (progressBar) {
      progressBar.start(totalFiles, 0, {
        speed: formatBytes(0),
        elapsed: '0',
      })
    }

    const updateProgress = () => {
      const elapsedSeconds = (Date.now() - startAt) / 1000
      const speed = elapsedSeconds > 0 ? uploadedBytes / elapsedSeconds : 0

      if (!progressBar) {
        const progressRatio = totalFiles > 0 ? completed / totalFiles : 1
        const percentage = Math.round(progressRatio * 100)
        if (completed === 0 && totalFiles > 0) return
        if (completed === lastReportedCompleted) return
        if (completed === totalFiles || completed % reportEvery === 0) {
          console.log(
            `${chalk.gray('上传进度')} ${renderInlineStats([
              chalk.bold(`${completed}/${totalFiles}`),
              `${percentage}%`,
              `${formatBytes(uploadedBytes)}/${formatBytes(totalBytes)}`,
              `${formatBytes(speed)}/s`,
            ])}`,
          )
          lastReportedCompleted = completed
        }
        return
      }

      progressBar.update(completed, {
        speed: chalk.magenta(formatBytes(speed)),
        elapsed: formatDuration(elapsedSeconds).replace(/s$/, ''),
      })
    }

    const refreshTimer = progressBar ? setInterval(updateProgress, 120) : null
    let currentIndex = 0

    const worker = async () => {
      while (true) {
        const index = currentIndex++
        if (index >= tasks.length) return

        const task = tasks[index]
        updateProgress()

        const result = await uploadFileWithRetry(client, task, silentLogs)
        completed++
        retries += result.retries
        if (result.success) {
          uploadedBytes += result.size
        } else {
          failed++
        }
        results.push(result)
        updateProgress()
      }
    }

    updateProgress()

    try {
      await Promise.all(Array.from({ length: safeWindowSize }, () => worker()))
    } finally {
      if (refreshTimer) clearInterval(refreshTimer)
    }

    if (progressBar) {
      const elapsedSeconds = (Date.now() - startAt) / 1000
      const speed = elapsedSeconds > 0 ? uploadedBytes / elapsedSeconds : 0
      progressBar.update(totalFiles, {
        speed: chalk.magenta(formatBytes(speed)),
        elapsed: formatDuration(elapsedSeconds).replace(/s$/, ''),
      })
      progressBar.stop()
    } else {
      console.log(`${getLogSymbol('success')} 所有文件上传完成 (${totalFiles}/${totalFiles})`)
    }

    return results
  }
  return {
    name: 'vite-plugin-deploy-oss',
    apply: 'build',
    enforce: 'post',
    buildEnd(error) {
      if (error) buildFailed = true
    },
    config(config) {
      if (!open || buildFailed) return

      const validationErrors = validateOptions()
      if (validationErrors.length > 0) {
        console.log(`${chalk.red('✗ 配置错误:')}\n${validationErrors.map((err) => `  - ${err}`).join('\n')}`)
        return
      }

      upload = true
      config.base = normalizedConfigBase || config.base
      return config
    },
    configResolved(config) {
      resolvedConfig = config
      outDir = normalizePath(resolve(config.root, config.build.outDir))
    },
    closeBundle: {
      sequential: true,
      order: 'post',
      async handler() {
        if (!open || !upload || buildFailed || !resolvedConfig) return

        const startTime = Date.now()
        const client = new oss({ region, accessKeyId, accessKeySecret, secure, bucket, ...props })
        const manifestFileName = resolveManifestFileName(manifest)

        const files = globSync('**/*', {
          cwd: outDir,
          nodir: true,
          ignore: Array.isArray(skip) ? skip : [skip],
        })
          .map((file) => normalizePath(file))
          .filter((file) => file !== manifestFileName)

        if (files.length === 0) {
          console.log(`${getLogSymbol('warning')} 没有找到需要上传的文件`)
          return
        }

        clearViewport()
        console.log(
          renderPanel(
            '准备部署',
            [
              { label: '位置:', value: chalk.green(`${bucket} · ${region}`) },
              {
                label: '目标:',
                value: chalk.yellow(
                  truncateTerminalText(
                    normalizedAlias ? `${normalizedUploadDir || '/'} · ${normalizedAlias}` : normalizedUploadDir || '/',
                    18,
                  ),
                ),
              },
              {
                label: '文件:',
                value: chalk.blue(`${files.length} 个 · ${truncateTerminalText(outDir, 30)}`),
              },
            ],
            'info',
          ),
        )

        try {
          const results = await uploadFilesInBatches(client, files, concurrency)

          const successCount = results.filter((r) => r.success).length
          const failedCount = results.length - successCount
          const durationSeconds = (Date.now() - startTime) / 1000
          const uploadedBytes = results.reduce((sum, result) => (result.success ? sum + result.size : sum), 0)
          const retryCount = results.reduce((sum, result) => sum + result.retries, 0)
          const avgSpeed = durationSeconds > 0 ? uploadedBytes / durationSeconds : 0
          let manifestSummary: string | null = null

          if (manifestFileName) {
            const manifestRelativeFilePath = manifestFileName
            const manifestFilePath = normalizePath(resolve(outDir, manifestRelativeFilePath))
            const manifestObjectKey = normalizeObjectKey(normalizedUploadDir, manifestRelativeFilePath)

            await mkdir(dirname(manifestFilePath), { recursive: true })
            await writeFile(
              manifestFilePath,
              JSON.stringify(await createManifestPayload(results, normalizedConfigBase, normalizedAlias), null, 2),
              'utf8',
            )

            const manifestStats = await stat(manifestFilePath)
            const manifestResult = await uploadSingleTask(client, {
              filePath: manifestFilePath,
              relativeFilePath: manifestRelativeFilePath,
              name: manifestObjectKey,
              size: manifestStats.size,
              cacheControl: 'no-cache, no-store, must-revalidate',
            })

            if (!manifestResult.success) {
              throw manifestResult.error || new Error(`Failed to upload manifest: ${manifestRelativeFilePath}`)
            }

            const manifestUrl = resolveUploadedFileUrl(
              manifestRelativeFilePath,
              manifestObjectKey,
              normalizedConfigBase,
              normalizedAlias,
            )
            manifestSummary = truncateTerminalText(manifestUrl || manifestObjectKey, 20)
          }

          try {
            await removeEmptyDirectories(outDir)
          } catch (error) {
            console.warn(`${getLogSymbol('warning')} 清理空目录失败: ${error}`)
          }

          const resultRows = [
            {
              label: '结果:',
              value:
                failedCount === 0
                  ? chalk.green(`${successCount}/${results.length} 全部成功`)
                  : chalk.yellow(`成功 ${successCount} 个，失败 ${failedCount} 个`),
            },
            {
              label: '统计:',
              value: renderInlineStats([
                `${retryCount} 次重试`,
                formatBytes(uploadedBytes),
                `${formatBytes(avgSpeed)}/s`,
                formatDuration(durationSeconds),
              ]),
            },
            ...(manifestSummary ? [{ label: '清单:', value: chalk.cyan(manifestSummary) }] : []),
          ]

          if (failedCount > 0) {
            const failedItems = results.filter((result) => !result.success).slice(0, 2)
            resultRows.push(
              ...failedItems.map((item, index) => ({
                label: `失败 ${index + 1}`,
                value: chalk.red(
                  `${truncateTerminalText(item.name, 26)} · ${truncateTerminalText(item.error?.message || 'unknown error', 22)}`,
                ),
              })),
            )
            if (failedCount > failedItems.length) {
              resultRows.push({
                label: '其余',
                value: chalk.gray(`还有 ${failedCount - failedItems.length} 个失败项未展开`),
              })
            }
          }

          console.log(
            renderPanel(
              failedCount === 0 ? `${getLogSymbol('success')} 部署完成` : `${getLogSymbol('warning')} 部署完成`,
              resultRows,
              failedCount === 0 ? 'success' : 'warning',
            ),
          )

          if (failedCount > 0 && failOnError) {
            throw new Error(`Failed to upload ${failedCount} of ${results.length} files`)
          }
        } catch (error) {
          console.log(`\n${getLogSymbol('danger')} 上传过程中发生错误: ${error}\n`)
          if (failOnError) {
            throw error instanceof Error ? error : new Error(String(error))
          }
        }
      },
    },
  }
}
