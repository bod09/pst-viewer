import { useBranding } from '../lib/branding'

/** The logo + name + tagline block shown in the nav pane and the empty state. */
export function BrandHeader() {
  const brand = useBranding()
  return (
    <>
      <img
        src={brand.logo || `${import.meta.env.BASE_URL}icon.svg`}
        alt=""
        className="h-7 w-7 object-contain"
      />
      <div className="leading-tight">
        <div className="text-sm font-semibold text-slate-100">{brand.name}</div>
        <div className="text-[11px] text-slate-400">{brand.tagline}</div>
      </div>
    </>
  )
}
