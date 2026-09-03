/**
 * The email-client style leading slot of a message row: a coloured initial
 * for the sender that turns into a selection checkbox on hover, and stays a
 * checkbox while selected.
 */

const PALETTE: Array<[string, string]> = [
  ['bg-sky-500/20', 'text-sky-300'],
  ['bg-emerald-500/20', 'text-emerald-300'],
  ['bg-amber-500/20', 'text-amber-300'],
  ['bg-rose-500/20', 'text-rose-300'],
  ['bg-violet-500/20', 'text-violet-300'],
  ['bg-cyan-500/20', 'text-cyan-300'],
  ['bg-fuchsia-500/20', 'text-fuchsia-300'],
  ['bg-lime-500/20', 'text-lime-300'],
]

function colorOf(name: string): [string, string] {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

function initialOf(name: string): string {
  const m = name.match(/[\p{L}\p{N}]/u)
  return m ? m[0].toUpperCase() : '?'
}

export function SelectAvatar({
  name,
  checked,
  onToggle,
}: {
  name: string
  checked: boolean
  onToggle: () => void
}) {
  const [bg, fg] = colorOf(name)
  return (
    <label
      className="group/sel flex cursor-pointer items-center pl-2.5 pr-2.5"
      data-tip="Select for PDF export"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="relative flex h-8 w-8 items-center justify-center">
        <span
          className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold transition-opacity duration-150 ${bg} ${fg} ${
            checked ? 'opacity-0' : 'group-hover/sel:opacity-0'
          }`}
        >
          {initialOf(name)}
        </span>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className={`pstv-check absolute inset-0 m-auto transition-opacity duration-150 ${
            checked ? 'opacity-100' : 'opacity-0 group-hover/sel:opacity-100'
          }`}
        />
      </span>
    </label>
  )
}
