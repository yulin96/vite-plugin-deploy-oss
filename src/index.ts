import oss from 'ali-oss'
import chalk from 'chalk'
import { globSync } from 'glob'
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import ora from 'ora'
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
import { buildCapsuleBar, formatBytes, formatDuration, trimMiddle } from './utils/progress'
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
  const clearScreen = () => {
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
        const result =
          shouldUseMultipart ?
            await client.multipartUpload(task.name, task.filePath, {
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
              console.warn(`${chalk.yellow('⚠')} 删除本地文件失败: ${task.filePath}`)
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
            console.log(
              `${chalk.red('✗')} ${task.filePath} => ${error instanceof Error ? error.message : String(error)}`,
            )
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
            console.log(`${chalk.yellow('⚠')} ${task.filePath} 上传失败，正在重试 (${attempt}/${maxRetries})...`)
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
    const activeFiles = new Set<string>()
    const safeWindowSize = Math.max(1, Math.min(windowSize, tasks.length || 1))
    const silentLogs = Boolean(useInteractiveOutput)

    const spinner = useInteractiveOutput ? ora({ text: '准备上传...', spinner: 'dots12' }).start() : null
    const reportEvery = Math.max(1, Math.ceil(totalFiles / 10))
    let lastReportedCompleted = -1

    const updateProgress = () => {
      const progressRatio = totalFiles > 0 ? completed / totalFiles : 1
      const percentage = Math.round(progressRatio * 100)
      const elapsedSeconds = (Date.now() - startAt) / 1000
      const speed = elapsedSeconds > 0 ? uploadedBytes / elapsedSeconds : 0
      const etaSeconds = speed > 0 ? Math.max(0, (totalBytes - uploadedBytes) / speed) : 0
      const activeList = Array.from(activeFiles)
      const currentFile = activeList.length > 0 ? trimMiddle(activeList[activeList.length - 1], 86) : '-'

      if (!spinner) {
        if (completed === lastReportedCompleted) return
        if (completed === totalFiles || completed % reportEvery === 0) {
          console.log(
            `${chalk.gray('进度:')} ${completed}/${totalFiles} (${percentage}%) | ${chalk.gray('数据:')} ${formatBytes(uploadedBytes)}/${formatBytes(totalBytes)} | ${chalk.gray('速度:')} ${formatBytes(speed)}/s`,
          )
          lastReportedCompleted = completed
        }
        return
      }

      const bar = buildCapsuleBar(progressRatio)
      const warnLine =
        retries > 0 || failed > 0 ? `\n${chalk.yellow('重试')}: ${retries}  ${chalk.yellow('失败')}: ${failed}` : ''

      spinner.text = [
        `${chalk.cyan('正在上传:')} ${chalk.white(currentFile)}`,
        `${bar} ${chalk.bold(`${percentage}%`)} ${chalk.gray(`(${completed}/${totalFiles})`)} ${chalk.gray('|')} ${chalk.blue(formatBytes(uploadedBytes))}/${chalk.blue(formatBytes(totalBytes))} ${chalk.gray('|')} ${chalk.magenta(`${formatBytes(speed)}/s`)} ${chalk.gray('|')} 预计 ${chalk.yellow(formatDuration(etaSeconds))}`,
      ].join('\n')
      spinner.text += warnLine
    }

    const refreshTimer = spinner ? setInterval(updateProgress, 120) : null
    let currentIndex = 0

    const worker = async () => {
      while (true) {
        const index = currentIndex++
        if (index >= tasks.length) return

        const task = tasks[index]
        activeFiles.add(task.name)
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
        activeFiles.delete(task.name)
        updateProgress()
      }
    }

    updateProgress()

    try {
      await Promise.all(Array.from({ length: safeWindowSize }, () => worker()))
    } finally {
      if (refreshTimer) clearInterval(refreshTimer)
    }

    if (spinner) {
      const elapsedSeconds = (Date.now() - startAt) / 1000
      const successCount = results.filter((item) => item.success).length
      const speed = elapsedSeconds > 0 ? uploadedBytes / elapsedSeconds : 0
      spinner.succeed(
        `${chalk.green('上传成功')} ${successCount} 个文件。\n${buildCapsuleBar(1)} 100% (${totalFiles}/${totalFiles}) ${chalk.gray('|')} 速度 ${chalk.magenta(`${formatBytes(speed)}/s`)} ${chalk.gray('|')} 耗时 ${chalk.yellow(formatDuration(elapsedSeconds))}`,
      )
    } else {
      console.log(`${chalk.green('✔')} 所有文件上传完成 (${totalFiles}/${totalFiles})`)
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

      clearScreen()

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
          console.log(`${chalk.yellow('⚠ 没有找到需要上传的文件')}`)
          return
        }

        clearScreen()
        console.log(chalk.cyan(`\n🚀 OSS 部署开始\n`))
        console.log(`${chalk.gray('Bucket:')}   ${chalk.green(bucket)}`)
        console.log(`${chalk.gray('Region:')}   ${chalk.green(region)}`)
        console.log(`${chalk.gray('Source:')}   ${chalk.yellow(outDir)}`)
        console.log(`${chalk.gray('Target:')}   ${chalk.yellow(normalizedUploadDir || '/')}`)
        if (normalizedAlias) console.log(`${chalk.gray('Alias:')}    ${chalk.green(normalizedAlias)}`)
        console.log(`${chalk.gray('Files:')}    ${chalk.blue(files.length)}\n`)

        try {
          const results = await uploadFilesInBatches(client, files, concurrency)

          const successCount = results.filter((r) => r.success).length
          const failedCount = results.length - successCount
          const durationSeconds = (Date.now() - startTime) / 1000
          const duration = durationSeconds.toFixed(2)
          const uploadedBytes = results.reduce((sum, result) => (result.success ? sum + result.size : sum), 0)
          const retryCount = results.reduce((sum, result) => sum + result.retries, 0)
          const avgSpeed = durationSeconds > 0 ? uploadedBytes / durationSeconds : 0

          clearScreen()
          console.log('\n' + chalk.gray('─'.repeat(40)) + '\n')

          if (failedCount === 0) {
            console.log(`${chalk.green('🎉 部署成功!')}`)
          } else {
            console.log(`${chalk.yellow('⚠ 部署完成但存在错误')}`)
          }

          console.log(`\n${chalk.gray('统计:')}`)
          console.log(` ${chalk.green('✔')} 成功: ${chalk.bold(successCount)}`)
          if (failedCount > 0) {
            console.log(` ${chalk.red('✗')} 失败: ${chalk.bold(failedCount)}`)
          }
          console.log(` ${chalk.cyan('⇄')} 重试: ${chalk.bold(retryCount)}`)
          console.log(` ${chalk.blue('📦')} 数据: ${chalk.bold(formatBytes(uploadedBytes))}`)
          console.log(` ${chalk.magenta('⚡')} 平均速度: ${chalk.bold(`${formatBytes(avgSpeed)}/s`)}`)
          console.log(` ${chalk.blue('⏱')} 耗时: ${chalk.bold(duration)}s`)

          console.log('')

          if (failedCount > 0) {
            const failedItems = results.filter((result) => !result.success)
            const previewCount = Math.min(5, failedItems.length)
            console.log(chalk.red('失败明细:'))
            for (let i = 0; i < previewCount; i++) {
              const item = failedItems[i]
              const reason = item.error?.message || 'unknown error'
              console.log(` ${chalk.red('•')} ${item.name} => ${reason}`)
            }
            if (failedItems.length > previewCount) {
              console.log(chalk.gray(` ... 还有 ${failedItems.length - previewCount} 个失败文件`))
            }
            console.log('')
          }

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

            console.log(chalk.cyan('Manifest:'))
            console.log(` ${chalk.gray('File:')}   ${chalk.yellow(manifestFilePath)}`)
            console.log(` ${chalk.gray('Target:')} ${chalk.yellow(manifestObjectKey)}`)
            console.log(` ${chalk.gray('URL:')}    ${chalk.green(manifestUrl)}`)
            console.log('')
          }

          try {
            await removeEmptyDirectories(outDir)
          } catch (error) {
            console.warn(`${chalk.yellow('⚠ 清理空目录失败:')} ${error}`)
          }

          if (failedCount > 0 && failOnError) {
            throw new Error(`Failed to upload ${failedCount} of ${results.length} files`)
          }
        } catch (error) {
          console.log(`\n${chalk.red('❌ 上传过程中发生错误:')} ${error}\n`)
          if (failOnError) {
            throw error instanceof Error ? error : new Error(String(error))
          }
        }
      },
    },
  }
}
