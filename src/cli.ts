#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deployOss } from './deploy'
import type { DeployOssOption } from './types'

const DEFAULT_CONFIG_FILES = [
  'deploy-oss.config.js',
  'deploy-oss.config.mjs',
  'deploy-oss.config.cjs',
  'deploy-oss.config.json',
]

const helpText = `
Usage:
  deploy-oss --config deploy-oss.config.mjs
  deploy-oss --outDir dist --uploadDir H5/demo/prod

Options:
  --config <path>          Config file path
  --outDir <path>          Local directory to upload, default dist
  --uploadDir <path>       OSS target directory
  --region <region>        OSS region
  --bucket <bucket>        OSS bucket
  --accessKeyId <value>    OSS access key ID
  --accessKeySecret <value>
  --configBase <url>       URL base used by manifest
  --alias <url>            URL alias used by manifest
  --skip <glob>            Glob to skip, can be used multiple times
  --manifest [file]        Enable manifest, optional file name
  --concurrency <number>   Upload concurrency
  --retryTimes <number>    Retry times
  --debug                  Show debug timing
  --no-fancy               Disable styled progress
  --no-cache               Set no-cache headers
  --no-overwrite           Forbid overwrite
  --no-fail-on-error       Do not exit with error on upload failure
  -h, --help               Show help
`.trim()

const readValue = (args: string[], index: number, name: string): string => {
  const value = args[index + 1]
  if (!value || value.startsWith('-')) {
    throw new Error(`${name} requires a value`)
  }
  return value
}

const parseArgs = (args: string[]): { configPath?: string; option: Partial<DeployOssOption>; help: boolean } => {
  const option: Partial<DeployOssOption> = {}
  let configPath: string | undefined
  let help = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case '-h':
      case '--help':
        help = true
        break
      case '--config':
        configPath = readValue(args, i, arg)
        i++
        break
      case '--outDir':
      case '--uploadDir':
      case '--region':
      case '--bucket':
      case '--accessKeyId':
      case '--accessKeySecret':
      case '--configBase':
      case '--alias': {
        const key = arg.slice(2) as keyof DeployOssOption
        option[key] = readValue(args, i, arg) as never
        i++
        break
      }
      case '--skip': {
        const value = readValue(args, i, arg)
        option.skip = Array.isArray(option.skip) ? [...option.skip, value] : option.skip ? [option.skip, value] : value
        i++
        break
      }
      case '--manifest': {
        const next = args[i + 1]
        if (next && !next.startsWith('-')) {
          option.manifest = { fileName: next }
          i++
        } else {
          option.manifest = true
        }
        break
      }
      case '--debug':
        option.debug = true
        break
      case '--no-fancy':
        option.fancy = false
        break
      case '--no-cache':
        option.noCache = true
        break
      case '--no-overwrite':
        option.overwrite = false
        break
      case '--no-fail-on-error':
        option.failOnError = false
        break
      case '--concurrency':
      case '--retryTimes':
      case '--multipartThreshold': {
        const key = arg.slice(2) as 'concurrency' | 'retryTimes' | 'multipartThreshold'
        option[key] = Number(readValue(args, i, arg))
        i++
        break
      }
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  return { configPath, option, help }
}

const findDefaultConfig = async (): Promise<string | undefined> => {
  for (const file of DEFAULT_CONFIG_FILES) {
    const filePath = resolve(file)
    try {
      await access(filePath)
      return filePath
    } catch {}
  }
}

const loadConfig = async (configPath?: string): Promise<Partial<DeployOssOption>> => {
  const resolvedConfigPath = configPath ? resolve(configPath) : await findDefaultConfig()
  if (!resolvedConfigPath) return {}

  if (extname(resolvedConfigPath) === '.json') {
    return JSON.parse(await readFile(resolvedConfigPath, 'utf8')) as Partial<DeployOssOption>
  }

  const mod = (await import(pathToFileURL(resolvedConfigPath).href)) as {
    default?: Partial<DeployOssOption>
    deployOss?: Partial<DeployOssOption>
  }
  return mod.default || mod.deployOss || {}
}

const main = async () => {
  const { configPath, option, help } = parseArgs(process.argv.slice(2))

  if (help) {
    console.log(helpText)
    return
  }

  const config = await loadConfig(configPath)
  await deployOss({
    ...config,
    ...option,
  } as DeployOssOption)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
