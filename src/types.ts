import type oss from 'ali-oss'

export interface ManifestOption {
  fileName?: string
}

export type ManifestConfig = boolean | ManifestOption | undefined

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
  fancy?: boolean

  noCache?: boolean
  failOnError?: boolean

  concurrency?: number
  retryTimes?: number
  multipartThreshold?: number
  manifest?: ManifestConfig
}

export interface UploadResult {
  success: boolean
  file: string
  relativeFilePath: string
  name: string
  size: number
  retries: number
  error?: Error
}

export interface UploadTask {
  filePath: string
  relativeFilePath: string
  name: string
  size: number
  cacheControl?: string
}

export interface ManifestFileItem {
  file: string
  key: string
  url: string
  md5: string
}

export interface ManifestPayload {
  version: number
  files: ManifestFileItem[]
}
