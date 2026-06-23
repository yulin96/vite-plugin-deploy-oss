import { resolve } from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'
import { deployOss } from './deploy'
import type {
  DeployOssOption,
  DeployOssResult,
  ManifestConfig,
  ManifestFileItem,
  ManifestOption,
  ManifestPayload,
  UploadResult,
  UploadTask,
  vitePluginDeployOssOption,
} from './types'
import { ensureTrailingSlash, normalizeSlash, normalizeUrlLikeBase } from './utils/path'

export { deployOss }
export const defineDeployConfig = (option: DeployOssOption): DeployOssOption => option
export type {
  DeployOssOption,
  DeployOssResult,
  ManifestConfig,
  ManifestFileItem,
  ManifestOption,
  ManifestPayload,
  UploadResult,
  UploadTask,
  vitePluginDeployOssOption,
} from './types'

export default function vitePluginDeployOss(option: vitePluginDeployOssOption): Plugin {
  const { open = true, configBase } = option || {}

  let buildFailed = false
  let upload = false
  let outDir = normalizeSlash(resolve('dist'))
  let resolvedConfig: ResolvedConfig | null = null
  const normalizedConfigBase = configBase ? ensureTrailingSlash(normalizeUrlLikeBase(configBase)) : undefined

  return {
    name: 'vite-plugin-deploy-oss',
    apply: 'build',
    enforce: 'post',
    buildEnd(error) {
      if (error) buildFailed = true
    },
    config(config) {
      if (!open || buildFailed) return

      upload = true
      config.base = normalizedConfigBase || config.base
      return config
    },
    configResolved(config) {
      resolvedConfig = config
      outDir = normalizeSlash(resolve(config.root, config.build.outDir))
    },
    closeBundle: {
      sequential: true,
      order: 'post',
      async handler() {
        if (!open || !upload || buildFailed || !resolvedConfig) return

        await deployOss({
          ...option,
          configBase: normalizedConfigBase,
          outDir,
        })
      },
    },
  }
}
