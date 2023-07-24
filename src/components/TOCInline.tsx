import { Toc } from 'types/Toc'

interface TOCInlineProps {
  toc: Toc
  indentDepth?: number
  fromHeading?: number
  toHeading?: number
  asDisclosure?: boolean
  collapseSubheadings?: boolean
  exclude?: string | string[]
}

interface TocEntry {
  heading: Toc[number]
  children: TocEntry[]
}

function CollapsibleToc({ entries }: { entries: TocEntry[] }) {
  return (
    <>
      {entries.map(({ heading, children }) => (
        <li key={heading.url}>
          {children.length ? (
            <details className="toc-branch">
              <summary className="flex cursor-pointer list-none items-start gap-1.5 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500">
                <span
                  aria-hidden="true"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                >
                  <span className="toc-chevron" />
                </span>
                <a className="text-primary-500" href={heading.url}>
                  {heading.value}
                </a>
              </summary>
              <ul className="ml-4">
                <CollapsibleToc entries={children} />
              </ul>
            </details>
          ) : (
            <a className="text-primary-500" href={heading.url}>
              {heading.value}
            </a>
          )}
        </li>
      ))}
    </>
  )
}

/**
 * Generates an inline table of contents
 * Exclude titles matching this string (new RegExp('^(' + string + ')$', 'i')).
 * If an array is passed the array gets joined with a pipe (new RegExp('^(' + array.join('|') + ')$', 'i')).
 *
 * @param {TOCInlineProps} {
 *   toc,
 *   indentDepth = 3,
 *   fromHeading = 1,
 *   toHeading = 6,
 *   asDisclosure = false,
 *   exclude = '',
 * }
 *
 */
const TOCInline = ({
  toc,
  indentDepth = 3,
  fromHeading = 1,
  toHeading = 6,
  asDisclosure = true,
  collapseSubheadings = false,
  exclude = '',
}: TOCInlineProps) => {
  const re = Array.isArray(exclude)
    ? new RegExp('^(' + exclude.join('|') + ')$', 'i')
    : new RegExp('^(' + exclude + ')$', 'i')

  const filteredToc = toc.filter(
    (heading) =>
      heading.depth >= fromHeading && heading.depth <= toHeading && !re.test(heading.value)
  )

  const entries: TocEntry[] = []
  const parents: TocEntry[] = []
  if (collapseSubheadings) {
    for (const heading of filteredToc) {
      while (parents.length && parents[parents.length - 1].heading.depth >= heading.depth) {
        parents.pop()
      }
      const entry: TocEntry = { heading, children: [] }
      const siblings = parents.length ? parents[parents.length - 1].children : entries
      siblings.push(entry)
      parents.push(entry)
    }
  }

  const tocList = (
    <ul className="py-4 text-sm font-medium leading-relaxed xl:border-b xl:border-gray-200 xl:dark:border-gray-700">
      {collapseSubheadings ? (
        <CollapsibleToc entries={entries} />
      ) : (
        filteredToc.map((heading) => (
          <li key={heading.url} className={heading.depth >= indentDepth ? 'ml-6' : undefined}>
            <a className="text-primary-500" href={heading.url}>
              {heading.value}
            </a>
          </li>
        ))
      )}
    </ul>
  )

  return (
    <>
      {asDisclosure ? (
        <details open>
          <summary className="ml-6 pt-2 pb-2 text-xl font-bold">目录</summary>
          <div className="ml-6">{tocList}</div>
        </details>
      ) : (
        tocList
      )}
    </>
  )
}

export default TOCInline
