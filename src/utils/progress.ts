import chalk from 'chalk'

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }

  const digits = value >= 100 || unitIndex === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '--'

  const rounded = Math.round(seconds)
  const mins = Math.floor(rounded / 60)
  const secs = rounded % 60

  if (mins === 0) return `${secs}s`
  return `${mins}m${String(secs).padStart(2, '0')}s`
}

export const trimMiddle = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text
  if (maxLength <= 10) return text.slice(0, maxLength)

  const leftLength = Math.floor((maxLength - 3) / 2)
  const rightLength = maxLength - 3 - leftLength
  return `${text.slice(0, leftLength)}...${text.slice(-rightLength)}`
}

export const buildCapsuleBar = (ratio: number, width = 30): string => {
  const safeRatio = Math.max(0, Math.min(1, ratio))
  if (width <= 0) return ''

  if (safeRatio >= 1) {
    return chalk.green('█'.repeat(width))
  }

  const pointerIndex = Math.min(width - 1, Math.floor(width * safeRatio))
  const done = pointerIndex > 0 ? chalk.green('█'.repeat(pointerIndex)) : ''
  const pointer = chalk.cyanBright('▸')
  const pending = pointerIndex < width - 1 ? chalk.gray('░'.repeat(width - pointerIndex - 1)) : ''

  return `${done}${pointer}${pending}`
}
