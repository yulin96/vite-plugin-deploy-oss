import chalk from 'chalk'
import cliTruncate from 'cli-truncate'
import logSymbols from 'log-symbols'
import stringWidth from 'string-width'

export interface TerminalRow {
  label: string
  value: string
}

type PanelTone = 'info' | 'success' | 'warning' | 'danger'

const panelBorderColor: Record<PanelTone, string> = {
  info: 'cyan',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
}

const getTerminalWidth = () => process.stdout?.columns || 100
const getPanelInnerWidth = () => Math.max(46, Math.min(84, getTerminalWidth() - 4))
const padVisual = (text: string, width: number) => `${text}${' '.repeat(Math.max(0, width - stringWidth(text)))}`
const fitVisual = (text: string, width: number) => {
  if (width <= 0) return ''
  return padVisual(cliTruncate(text, width, { position: 'middle' }), width)
}

export const truncateTerminalText = (text: string, reservedWidth = 26): string => {
  const maxWidth = Math.max(24, Math.min(88, getTerminalWidth() - reservedWidth))
  return cliTruncate(text, maxWidth, { position: 'middle' })
}

export const renderPanel = (title: string, rows: TerminalRow[], tone: PanelTone = 'info', footer?: string): string => {
  const color = chalk[panelBorderColor[tone] as keyof typeof chalk] as (text: string) => string
  const innerWidth = getPanelInnerWidth()
  const labelWidth = rows.length > 0 ? Math.max(...rows.map((row) => stringWidth(row.label))) : 0
  const contentLines: string[] = [chalk.bold(cliTruncate(title, innerWidth, { position: 'end' }))]

  if (rows.length > 0) {
    contentLines.push('')
    for (const row of rows) {
      const paddedLabel = padVisual(row.label, labelWidth)
      const prefix = `${paddedLabel}  `
      const availableValueWidth = Math.max(8, innerWidth - stringWidth(prefix))
      contentLines.push(`${chalk.gray(prefix)}${fitVisual(row.value, availableValueWidth)}`)
    }
  }

  if (footer) {
    contentLines.push('')
    contentLines.push(chalk.gray(cliTruncate(footer, innerWidth, { position: 'middle' })))
  }

  const top = color(`╭${'─'.repeat(innerWidth + 2)}╮`)
  const bottom = color(`╰${'─'.repeat(innerWidth + 2)}╯`)
  const body = contentLines.map((line) => `${color('│')} ${fitVisual(line, innerWidth)} ${color('│')}`).join('\n')
  return `${top}\n${body}\n${bottom}`
}

export const renderInlineStats = (items: Array<string | false | null | undefined>): string =>
  items.filter(Boolean).join(chalk.gray(' · '))

export const getLogSymbol = (tone: Exclude<PanelTone, 'info'>): string => {
  switch (tone) {
    case 'success':
      return logSymbols.success
    case 'warning':
      return logSymbols.warning
    case 'danger':
      return logSymbols.error
  }
}
