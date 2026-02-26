import oss from 'ali-oss'
import chalk from 'chalk'
import deleteEmpty from 'delete-empty'
import { globSync } from 'glob'
import { stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import ora from 'ora'
import { normalizePath, Plugin } from 'vite'

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

  // 新增配置项
  concurrency?: number // 并发上传数量
  retryTimes?: number // 重试次数
  multipartThreshold?: number // 超过该大小（字节）走分片上传
}

interface UploadResult {
  success: boolean
  file: string
  error?: Error
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
    noCache = false,
    concurrency = 5,
    retryTimes = 3,
    multipartThreshold = 10 * 1024 * 1024,
    ...props
  } = option || {}

  let buildFailed = false

  let upload = false
  let outDir = ''
  const useInteractiveOutput =
    Boolean(process.stdout?.isTTY) && Boolean(process.stderr?.isTTY) && !process.env.CI
  // 增加控制台监听器限制，防止警告
  const maxListeners = Math.max(20, concurrency * 3)
  process.stdout?.setMaxListeners?.(maxListeners)
  process.stderr?.setMaxListeners?.(maxListeners)
  const clearScreen = () => {
    if (!useInteractiveOutput) return
    process.stdout.write('\x1b[2J\x1b[0f')
  }

  // 参数验证函数
  const validateOptions = (): string[] => {
    const errors: string[] = []
    if (!accessKeyId) errors.push('accessKeyId is required')
    if (!accessKeySecret) errors.push('accessKeySecret is required')
    if (!bucket) errors.push('bucket is required')
    if (!region) errors.push('region is required')
    if (!uploadDir) errors.push('uploadDir is required')
    return errors
  } // 重试机制的上传函数
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
      ...(overwrite && {
        'x-oss-forbid-overwrite': 'false',
      }),
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
  } // 并发上传函数
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

    const updateProgress = () => {
      const percentage = Math.round((completed / totalFiles) * 100)

      if (!spinner) {
        if (completed === totalFiles || completed % reportEvery === 0) {
          console.log(`${chalk.gray('Progress:')} ${completed}/${totalFiles} (${percentage}%)`)
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

        const file = files[index]
        const filePath = normalizePath(file)
        const name = filePath.replace(outDir, uploadDir).replace(/\/\//g, '/')

        activeFile = name
        updateProgress()

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
      outDir = config.build?.outDir || 'dist'
      return config
    },
    closeBundle: {
      sequential: true,
      order: 'post',
      async handler() {
        if (!open || !upload || buildFailed) return

        const startTime = Date.now()
        const client = new oss({ region, accessKeyId, accessKeySecret, secure, bucket, ...props })

        const files = globSync(outDir + '/**/*', {
          nodir: true,
          ignore: Array.isArray(skip) ? skip : [skip],
        })

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

          // 清理空目录
          try {
            deleteEmpty(resolve(outDir))
          } catch (error) {
            console.warn(`${chalk.yellow('⚠ 清理空目录失败:')} ${error}`)
          }
        } catch (error) {
          console.log(`\n${chalk.red('❌ 上传过程中发生错误:')} ${error}\n`)
        }
      },
    },
  }
}
