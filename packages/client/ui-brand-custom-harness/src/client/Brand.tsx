import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './Brand.module.css'

type BrandMarkProps = SidebarBrandMarkOwnerProps | HeroBrandMarkOwnerProps

/**
 * Render the Harnessy mark at host-owned geometry.
 * @param props - Host-supplied mark presentation.
 * @returns the product mark at the requested size.
 */
export function CustomHarnessMark({ size, ...props }: BrandMarkProps) {
  const className = 'className' in props ? props.className : undefined
  const compact = size <= 24
  const source = compact
    ? requiredBuildValue('DSH_CLIENT_ICON_PATH', process.env.DSH_CLIENT_ICON_PATH)
    : requiredBuildValue('DSH_CLIENT_MARK_PATH', process.env.DSH_CLIENT_MARK_PATH)
  return (
    <span
      aria-hidden="true"
      className={[css.mark, compact && css.compactIcon, className].filter(Boolean).join(' ')}
      style={{ width: size, height: size }}
    >
      <img
        className={[css.markImage, compact && css.compactIconImage].filter(Boolean).join(' ')}
        src={source}
        alt=""
      />
    </span>
  )
}

/**
 * Render the product name independently from its mark.
 * @returns the centralized product display name.
 */
export function CustomHarnessName() {
  return <span className={css.wordmark}>{requiredBuildValue(
    'DSH_CLIENT_PRODUCT_NAME',
    process.env.DSH_CLIENT_PRODUCT_NAME,
  )}</span>
}

/** Props for the localized product orientation below the shared hero title. */
export type CustomHarnessTaglineProps =
  PropsRuntime<'conversation.hero.brand.tagline'> & PropsLocale<'customHarnessBrand'>

/**
 * Render the product-specific orientation beneath the shared new-session title.
 * @param props - Root slot values and localized Harnessy copy.
 * @returns a concise description of the workspace's purpose.
 */
export function CustomHarnessTagline({ t }: CustomHarnessTaglineProps) {
  return <p className={css.tagline}>{t('heroTagline')}</p>
}

/**
 * Require one product value from the named client build.
 * @param name - Build-time environment key to resolve.
 * @param value - Statically referenced build value, allowing the client bundler to inline it.
 * @returns the non-empty product value.
 */
export function requiredBuildValue(name: `DSH_CLIENT_${string}`, value: string | undefined): string {
  if (value === undefined || value === '') throw new Error(`custom-harness brand requires ${name}`)
  return value
}
