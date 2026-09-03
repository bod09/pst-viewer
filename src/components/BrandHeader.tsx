import { useBranding } from '../lib/branding'

/** The default mark, drawn inline so it follows the accent and theme colours
 *  (a custom deployment logo is an image and keeps its own colours). */
function DefaultLogo() {
  return (
    <svg viewBox="0 0 64 64" className="h-7 w-7 shrink-0">
      <rect x="4" y="4" width="56" height="56" rx="14" className="fill-slate-900" />
      <rect
        x="12" y="18" width="40" height="28" rx="4"
        fill="none" strokeWidth="3" className="stroke-sky-400"
      />
      <path
        d="M13 21 L32 35 L51 21"
        fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
        className="stroke-sky-400"
      />
    </svg>
  )
}

/** The logo + name + tagline block shown in the nav pane and the empty state. */
export function BrandHeader() {
  const brand = useBranding()
  return (
    <>
      {brand.logo ? (
        <img src={brand.logo} alt="" className="h-7 w-7 object-contain" />
      ) : (
        <DefaultLogo />
      )}
      <div className="leading-tight">
        <div className="text-sm font-semibold text-slate-100">{brand.name}</div>
        <div className="text-[11px] text-slate-400">{brand.tagline}</div>
      </div>
    </>
  )
}
