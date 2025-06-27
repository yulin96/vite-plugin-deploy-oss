import oss from 'ali-oss'
import chalk from 'chalk'
import deleteEmpty from 'delete-empty'
import { globSync } from 'glob'
import { unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizePath, Plugin } from 'vite'

export interface vitePluginDeployOssOption
  extends Omit<oss.Options, 'accessKeyId' | 'accessKeySecret' | 'bucket' | 'region'> {
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
  showProgress?: boolean // 显示上传进度
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
    showProgress = true,
    ...props
  } = option || {}

  let buildFailed = false

  let upload = false
  let outDir = ''
  // 增加控制台监听器限制，防止警告
  const maxListeners = Math.max(20, concurrency * 3)
  process.stdout?.setMaxListeners?.(maxListeners)
  process.stderr?.setMaxListeners?.(maxListeners)

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
    maxRetries: number = retryTimes
  ): Promise<UploadResult> => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await client.put(name, filePath, {
          timeout: 600000,
          headers: {
            'x-oss-storage-class': 'Standard',
            'x-oss-object-acl': 'default',
            'Cache-Control': noCache ? 'no-cache' : 'public, max-age=86400, immutable',
            ...(overwrite && {
              'x-oss-forbid-overwrite': 'false',
            }),
          },
        })

        if (result.res.status === 200) {
          const url = alias ? alias + name : result.url
          console.log(`${chalk.green('✓')} ${filePath} => ${chalk.cyan(url)}`)

          if (autoDelete) {
            try {
              unlinkSync(filePath)
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
    batchSize: number = concurrency
  ): Promise<UploadResult[]> => {
    const results: UploadResult[] = []
    const totalFiles = files.length
    let completed = 0

    // 分批处理文件，避免过多并发导致监听器警告
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize)

      const batchPromises = batch.map(async (file) => {
        const filePath = normalizePath(file)
        const name = filePath.replace(outDir, uploadDir).replace(/\/\//g, '/')

        const result = await uploadFileWithRetry(client, name, filePath)
        completed++

        if (showProgress) {
          const progress = Math.round((completed / totalFiles) * 100)
          console.log(`${chalk.blue('进度:')} ${progress}% (${completed}/${totalFiles})`)
        }

        return result
      })

      const batchResults = await Promise.all(batchPromises)
      results.push(...batchResults)
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
      config.base = configBase || config.base
      outDir = config.build?.outDir || 'dist'
      return config
    },
    closeBundle: {
      sequential: true,
      order: 'post',
      async handler() {
        if (!open || !upload || buildFailed) return

        console.log(`${chalk.blue('🚀 开始上传文件到 OSS...')}\n`)

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

        console.log(`${chalk.blue('📁 找到')} ${files.length} ${chalk.blue('个文件需要上传')}`)

        try {
          const results = await uploadFilesInBatches(client, files, concurrency)

          const successCount = results.filter((r) => r.success).length
          const failedCount = results.length - successCount
          const duration = ((Date.now() - startTime) / 1000).toFixed(2)

          console.log(`\n${chalk.blue('📊 上传统计:')}`)
          console.log(`  ${chalk.green('✓ 成功:')} ${successCount}`)
          if (failedCount > 0) {
            console.log(`  ${chalk.red('✗ 失败:')} ${failedCount}`)
          }
          console.log(`  ${chalk.blue('⏱ 耗时:')} ${duration}s`)

          // 清理空目录
          try {
            deleteEmpty(resolve(outDir))
          } catch (error) {
            console.warn(`${chalk.yellow('⚠ 清理空目录失败:')} ${error}`)
          }

          if (failedCount === 0) {
            console.log(`\n${chalk.green('🎉 所有文件上传完成!')}\n`)
          } else {
            console.log(`\n${chalk.yellow('⚠ 部分文件上传失败，请检查日志')}\n`)
          }
        } catch (error) {
          console.log(`\n${chalk.red('❌ 上传过程中发生错误:')} ${error}\n`)
        }
      },
    },
  }
}
