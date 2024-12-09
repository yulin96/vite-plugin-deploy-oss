import oss from 'ali-oss'
import chalk from 'chalk'
import deleteEmpty from 'delete-empty'
import { globSync } from 'glob'
import { unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizePath, Plugin } from 'vite'

export type vitePluginDeployOssOption = oss.Options & {
  configBase?: string

  accessKeyId: string
  accessKeySecret: string
  region?: string
  secure?: boolean
  bucket?: string
  overwrite?: boolean
  uploadDir: string

  alias?: string
  autoDelete?: boolean

  skip?: string | string[]
  open?: boolean
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
    ...props
  } = option || {}

  let upload = false
  let outDir = ''

  return {
    name: 'vite-plugin-deploy-oss',
    apply: 'build',
    enforce: 'post',
    config(config) {
      if (!open) return
      if (!accessKeyId || !accessKeySecret || !bucket || !region || !uploadDir) {
        console.log(`:: ${chalk.red('缺少必要参数')}`)
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
        if (!open) return
        if (!upload) return
        console.log(`:: ${chalk.blue('开始上传文件')} => \n`)
        const client = new oss({ region, accessKeyId, accessKeySecret, secure, bucket, ...props })
        const files = globSync(outDir + '/**/*', {
          nodir: true,
          ignore: Array.isArray(skip) ? skip : [skip],
        })

        for (const file of files) {
          const filePath = normalizePath(file)
          const name = filePath.replace('dist', `${uploadDir}`)

          try {
            const result = await client.put(name, filePath, {
              timeout: 600000,
              headers: {
                'x-oss-storage-class': 'Standard',
                'x-oss-object-acl': 'default',
                'Cache-Control': 'no-cache',
                ...(overwrite && {
                  'x-oss-forbid-overwrite': 'false',
                }),
              },
            })
            if (result.res.status === 200) {
              console.log(`上传成功 => ${chalk.green(alias ? alias + name : result.url)}`)

              if (autoDelete) unlinkSync(filePath)
            }
          } catch (error) {
            console.log(`${chalk.red('上传失败')} => ${error}`)
          }
        }

        deleteEmpty(resolve(outDir))
        console.log(`\n:: ${chalk.blue('上传完成')}\n`)
      },
    },
  }
}
