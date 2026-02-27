import oss from 'ali-oss'
import chalk from 'chalk'
import deleteEmpty from 'delete-empty'
import { globSync } from 'glob'
import { stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import ora from 'ora'
import { normalizePath, Plugin, type ResolvedConfig } from 'vite'

export interface vitePluginDeployOssOption extends Omit<
  oss.Options,
  'accessKeyId' | 'accessKeySecret' | 'bucket' | 'region'
> {
  configBase?: string

  accessKeyId: string
  accessKeySecret: string
  region: string
  secure?: boolean
  bucket: string
  overwrite?: boolean
  uploadDir: string

  alias?: string
  autoDelete?: boolean

  skip?: string | string[]
  open?: boolean

  noCache?: boolean
  failOnError?: boolean

  concurrency?: number
  retryTimes?: number
  multipartThreshold?: number
}

interface UploadResult {
  success: boolean
  file: string
  error?: Error
}

const normalizeObjectKey = (targetDir: string, relativeFilePath: string): string =>
  normalizePath(`${targetDir}/${relativeFilePath}`)
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')

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
    noCache = false,
    failOnError = true,
    concurrency = 5,
    retryTimes = 3,
    multipartThreshold = 10 * 1024 * 1024,
    ...props
  } = option || {}

  let buildFailed = false

  let upload = false
  let outDir = normalizePath(resolve('dist'))
  let resolvedConfig: ResolvedConfig | null = null
  const useInteractiveOutput =
    Boolean(process.stdout?.isTTY) && Boolean(process.stderr?.isTTY) && !process.env.CI
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
    if (!Number.isFinite(multipartThreshold) || multipartThreshold <= 0)
      errors.push('multipartThreshold must be > 0')
    return errors
  }

  const uploadFileWithRetry = async (
    client: oss,
    name: string,
    filePath: string,
    maxRetries: number = retryTimes,
  ): Promise<UploadResult> => {
    let shouldUseMultipart = false
    try {
      const fileStats = await stat(filePath)
      shouldUseMultipart = fileStats.size >= multipartThreshold
    } catch (error) {
      console.log(
        `${chalk.red('✗')} ${filePath} => 无法读取文件信息: ${error instanceof Error ? error.message : String(error)}`,
      )
      return { success: false, file: filePath, error: error as Error }
    }
    const headers = {
      'x-oss-storage-class': 'Standard',
      'x-oss-object-acl': 'default',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=86400, immutable',
      'x-oss-forbid-overwrite': overwrite ? 'false' : 'true',
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = shouldUseMultipart
          ? await client.multipartUpload(name, filePath, {
              timeout: 600000,
              partSize: 1024 * 1024,
              parallel: Math.max(1, Math.min(concurrency, 4)),
              headers,
            })
          : await client.put(name, filePath, {
              timeout: 600000,
              headers,
            })

        if (result.res.status === 200) {
          if (autoDelete) {
            try {
              await unlink(filePath)
            } catch (error) {
              console.warn(`${chalk.yellow('⚠')} 删除本地文件失败: ${filePath}`)
            }
          }

          return { success: true, file: filePath }
        } else {
          throw new Error(`Upload failed with status: ${result.res.status}`)
        }
      } catch (error) {
        if (attempt === maxRetries) {
          console.log(`${chalk.red('✗')} ${filePath} => ${error instanceof Error ? error.message : String(error)}`)
          return { success: false, file: filePath, error: error as Error }
        } else {
          console.log(`${chalk.yellow('⚠')} ${filePath} 上传失败，正在重试 (${attempt}/${maxRetries})...`)
          // 等待一段时间再重试
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
        }
      }
    }

    return { success: false, file: filePath, error: new Error('Max retries exceeded') }
  }

  const uploadFilesInBatches = async (
    client: oss,
    files: string[],
    windowSize: number = concurrency,
  ): Promise<UploadResult[]> => {
    const results: UploadResult[] = new Array(files.length)
    const totalFiles = files.length
    let completed = 0

    const spinner = useInteractiveOutput ? ora('准备上传...').start() : null
    const reportEvery = Math.max(1, Math.ceil(totalFiles / 10))
    let activeFile = ''
    let lastReportedCompleted = -1

    const updateProgress = () => {
      const percentage = Math.round((completed / totalFiles) * 100)

      if (!spinner) {
        if (completed === lastReportedCompleted) return
        if (completed === totalFiles || completed % reportEvery === 0) {
          console.log(`${chalk.gray('Progress:')} ${completed}/${totalFiles} (${percentage}%)`)
          lastReportedCompleted = completed
        }
        return
      }

      const width = 30
      const filled = Math.round((width * completed) / totalFiles)
      const empty = width - filled
      const bar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty))

      spinner.text = `正在上传: ${chalk.cyan(activeFile)}\n${bar} ${percentage}% (${completed}/${totalFiles})`
    }

    let currentIndex = 0
    const safeWindowSize = Math.max(1, Math.min(windowSize, totalFiles))

    const worker = async () => {
      while (true) {
        const index = currentIndex++
        if (index >= totalFiles) return

        const relativeFilePath = normalizePath(files[index])
        const filePath = normalizePath(resolve(outDir, relativeFilePath))
        const name = normalizeObjectKey(uploadDir, relativeFilePath)

        if (spinner) {
          activeFile = name
          updateProgress()
        }

        const result = await uploadFileWithRetry(client, name, filePath)
        completed++
        results[index] = result
        updateProgress()
      }
    }

    await Promise.all(Array.from({ length: safeWindowSize }, () => worker()))

    if (spinner) {
      const width = 30
      const bar = chalk.green('█'.repeat(width))
      spinner.succeed(`所有文件上传完成!\n${bar} 100% (${totalFiles}/${totalFiles})`)
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
      config.base = configBase || config.base
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

        const files = globSync('**/*', {
          cwd: outDir,
          nodir: true,
          ignore: Array.isArray(skip) ? skip : [skip],
        }).map((file) => normalizePath(file))

        if (files.length === 0) {
          console.log(`${chalk.yellow('⚠ 没有找到需要上传的文件')}`)
          return
        }

        clearScreen()
        console.log(chalk.cyan(`\n🚀 OSS 部署开始\n`))
        console.log(`${chalk.gray('Bucket:')}   ${chalk.green(bucket)}`)
        console.log(`${chalk.gray('Region:')}   ${chalk.green(region)}`)
        console.log(`${chalk.gray('Source:')}   ${chalk.yellow(outDir)}`)
        console.log(`${chalk.gray('Target:')}   ${chalk.yellow(uploadDir)}`)
        if (alias) console.log(`${chalk.gray('Alias:')}    ${chalk.green(alias)}`)
        console.log(`${chalk.gray('Files:')}    ${chalk.blue(files.length)}\n`)

        try {
          const results = await uploadFilesInBatches(client, files, concurrency)

          const successCount = results.filter((r) => r.success).length
          const failedCount = results.length - successCount
          const duration = ((Date.now() - startTime) / 1000).toFixed(2)

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
          console.log(` ${chalk.blue('⏱')} 耗时: ${chalk.bold(duration)}s`)

          console.log('')

          try {
            await deleteEmpty(resolve(outDir))
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
