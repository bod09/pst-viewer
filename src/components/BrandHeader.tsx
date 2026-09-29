import { useBranding } from '../lib/branding'

/** The default mark, drawn inline so it follows the accent and theme colours
 *  (a custom deployment logo is an image and keeps its own colours). */
function DefaultLogo({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className="shrink-0">
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

/** The logo + name + tagline block shown in the nav pane and the empty state.
 *
 *  The logo is sized by its height, with the width left to follow the image's
 *  own proportions. A wordmark is far wider than it is tall, so fitting one
 *  into a square box shrinks it until it reads as tiny next to the name; this
 *  way a wide logo stays as tall as it was asked to be.
 *
 *  The width is capped at half the row so a wide mark cannot crowd the name
 *  out of a narrow nav pane, and the text truncates rather than pushing the
 *  row out of shape. */
export function BrandHeader() {
  const brand = useBranding()
  return (
    <>
      {brand.logo ? (
        <img
          src={brand.logo}
          alt=""
          style={{ height: brand.logoSize }}
          className="w-auto max-w-[min(11rem,50%)] shrink-0 object-contain"
        />
      ) : (
        <DefaultLogo size={brand.logoSize} />
      )}
      <div className="min-w-0 leading-tight">
        <div className="truncate text-sm font-semibold text-slate-100">{brand.name}</div>
        <div className="truncate text-[11px] text-slate-400">{brand.tagline}</div>
      </div>
    </>
  )
}
