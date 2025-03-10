// Copyright 2022 the Deno authors. All rights reserved. MIT license.

import type { ComponentChildren } from "preact";
import algoliasearch from "$algolia";
import type {
  MultipleQueriesQuery,
  SearchResponse,
} from "$algolia/client-search";
import { createFetchRequester } from "$algolia/requester-fetch";
import { IS_BROWSER } from "$fresh/runtime.ts";
import { tw } from "twind";
import { css } from "twind/css";
import { useEffect, useRef, useState } from "preact/hooks";
import * as Icons from "@/components/Icons.tsx";
import { colors, docNodeKindMap } from "@/components/symbol_kind.tsx";
import { islandSearchClick } from "@/util/search_insights_utils.ts";

// Lazy load a <dialog> polyfill.
// @ts-expect-error HTMLDialogElement is not just a type!
if (IS_BROWSER && window.HTMLDialogElement === "undefined") {
  await import(
    "https://raw.githubusercontent.com/GoogleChrome/dialog-polyfill/5033aac1b74c44f36cde47be3d11f4756f3f8fda/dist/dialog-polyfill.esm.js"
  );
}

const MODULE_INDEX = "modules";
const SYMBOL_INDEX = "doc_nodes";
const MANUAL_INDEX = "manual";

const kinds = [
  "All",
  "Manual",
  "Modules",
  "Symbols",
] as const;

type SearchKinds = typeof kinds[number];

const symbolKinds = {
  "Namespaces": "namespace",
  "Classes": "class",
  "Enums": "enum",
  "Variables": "variable",
  "Functions": "function",
  "Interfaces": "interface",
  "Type Aliases": "typeAlias",
} as const;

type SymbolKinds = keyof typeof symbolKinds;

interface ManualSearchResult {
  docPath: string;
  hierarchy: Record<string, string>;
  anchor: string;
  content: string;
}

interface ModuleSearchResult {
  name: string;
  description: string;
}

interface SearchResults<ResultItem> {
  queryID?: string;
  hits: (ResultItem & { objectID: string })[];
  hitsPerPage: number;
  page: number;
}

/** Represents the search record being returned for a symbol. */
interface SymbolItem {
  name: string;
  sourceId: string;
  path?: string;
  doc?: string;
  category?: string;
  tags?: string[];
  source: number;
  popularity_score: number;
  kind:
    | "namespace"
    | "enum"
    | "variable"
    | "function"
    | "interface"
    | "typeAlias"
    | "moduleDoc"
    | "import";
  version: string;
  location: {
    filename: string;
    line: number;
    col: number;
  };
}

interface Results {
  manual?: SearchResults<ManualSearchResult>;
  modules?: SearchResults<ModuleSearchResult>;
  symbols?: SearchResults<SymbolItem>;
}

function toSearchResults<ResultItem>(
  // deno-lint-ignore no-explicit-any
  response: SearchResponse<any>[],
  index: string,
): SearchResults<ResultItem> | undefined {
  const result = response.find((res) => res.index === index);
  if (result) {
    const { queryID, hits, hitsPerPage, page } = result;
    return { queryID, hits, hitsPerPage, page };
  }
}

function getPosition(results: SearchResults<unknown>, index: number): number {
  return (results.hitsPerPage * results.page) + index + 1;
}

const requester = createFetchRequester();
const client = algoliasearch("QFPCRZC6WX", "2ed789b2981acd210267b27f03ab47da", {
  requester,
});

/** Search Deno documentation, symbols, or modules. */
export default function GlobalSearch({ denoVersion }: { denoVersion: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [showModal, setShowModal] = useState(false);
  const [input, setInput] = useState("");

  const [results, setResults] = useState<Results | null>(null);
  const [kind, setKind] = useState<SearchKinds>("All");
  const [page, setPage] = useState<number>(0);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [symbolKindsToggle, setSymbolKindsToggle] = useState<
    Record<SymbolKinds, boolean>
  >({
    "Namespaces": true,
    "Classes": true,
    "Enums": true,
    "Variables": true,
    "Functions": true,
    "Interfaces": true,
    "Type Aliases": true,
  });
  const searchTimeoutId = useRef<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const keyboardHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && showModal) setShowModal(false);
      if (e.target !== document.body) {
        return;
      }
      if (((e.metaKey || e.ctrlKey) && e.key === "k") || e.key === "/") {
        e.preventDefault();
        setShowModal(true);
      }
    };
    globalThis.addEventListener("keydown", keyboardHandler);
    return function cleanup() {
      globalThis.removeEventListener("keydown", keyboardHandler);
    };
  });

  useEffect(() => {
    if (!showModal) return;

    setLoading(true);
    if (searchTimeoutId.current === null) {
      searchTimeoutId.current = setTimeout(() => setResults(null), 500);
    }

    const queries: MultipleQueriesQuery[] = [];

    if (kind === "Manual" || kind === "All") {
      queries.push({
        indexName: MANUAL_INDEX,
        query: input || "Introduction",
        params: {
          page: page,
          hitsPerPage: kind === "All" ? 5 : 10,
          clickAnalytics: true,
          filters: "kind:paragraph",
        },
      });
    }

    if (kind === "Symbols" || kind === "All") {
      queries.push({
        indexName: SYMBOL_INDEX,
        query: input || "serve",
        params: {
          page: page,
          hitsPerPage: kind === "All" ? 5 : 10,
          clickAnalytics: true,
          filters: Object.entries(symbolKindsToggle)
            .filter(([_, v]) => kind === "Symbols" ? v : true)
            .map(([k]) => "kind:" + symbolKinds[k as keyof typeof symbolKinds])
            .join(" OR "),
        },
      });
    }

    if (kind === "Modules" || kind === "All") {
      queries.push({
        indexName: MODULE_INDEX,
        query: input,
        params: {
          page: page,
          hitsPerPage: kind === "All" ? 5 : 10,
          clickAnalytics: true,
        },
      });
    }

    let cancelled = false;

    client.multipleQueries(queries).then(
      ({ results }) => {
        // Ignore results from previous queries
        if (cancelled) return;
        if (searchTimeoutId.current !== null) {
          clearTimeout(searchTimeoutId.current);
          searchTimeoutId.current = null;
        }
        setTotalPages(results.find((res) => res.nbPages)?.nbPages ?? 1);
        setResults({
          manual: toSearchResults(results, MANUAL_INDEX),
          symbols: toSearchResults(results, SYMBOL_INDEX),
          modules: toSearchResults(results, MODULE_INDEX),
        });
        setLoading(false);
      },
    );

    return () => cancelled = true;
  }, [showModal, input, kind, symbolKindsToggle, page]);

  useEffect(() => {
    if (showModal) {
      document.body.style.overflow = "hidden";
      document.getElementById("search-input")?.focus();
    } else {
      document.body.style.overflow = "initial";
    }
  }, [showModal]);

  return (
    <>
      <button
        class="pl-4 bg-azure3 flex-grow lg:(w-80 flex-none) rounded-md text-default hover:bg-azure2 disabled:invisible"
        onClick={() => setShowModal(true)}
        disabled={!IS_BROWSER}
      >
        <div class="flex items-center pointer-events-none">
          <Icons.MagnifyingGlass />
          <div class="ml-1.5 py-2.5 h-9 flex-auto text-sm leading-4 font-medium text-left">
            Search...
          </div>
          <div class="mx-4">
            ⌘K
          </div>
        </div>
      </button>

      {IS_BROWSER && (
        <dialog
          class="bg-[#00000033] inset-0 fixed z-10 p-0 m-0 w-full h-screen"
          ref={dialog}
          onClick={() => setShowModal(false)}
          open={showModal}
        >
          <div
            class="bg-white w-full h-screen flex flex-col overflow-hidden lg:(mt-24 mx-auto rounded-md w-2/3 max-h-[80vh] border border-[#E8E7E5])"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="pt-6 px-6 border-b border-[#E8E7E5]">
              <div class="flex">
                <label
                  class={tw`px-4 h-10 w-full flex-shrink-1 bg-grayDefault rounded-md flex items-center placeholder:text-gray-400 focus-within:${
                    css({
                      "outline": "solid",
                    })
                  }`}
                >
                  <Icons.MagnifyingGlass />
                  <input
                    id="search-input"
                    class="ml-1.5 py-3 leading-4 bg-transparent w-full placeholder:text-gray-400 outline-none"
                    type="text"
                    onInput={(e) => setInput(e.currentTarget.value)}
                    value={input}
                    placeholder="Search manual, symbols and modules..."
                    autoFocus
                  />
                  {loading && <Icons.Spinner />}
                </label>

                <button
                  class="lg:hidden ml-3 -mr-2 flex items-center"
                  onClick={() => setShowModal(false)}
                >
                  <Icons.Cross />
                </button>
              </div>

              <div class="flex gap-3 mt-2">
                {kinds.map((k) => (
                  <button
                    class={tw`px-2 rounded-md leading-relaxed hover:(bg-grayDefault) ${
                      // TODO: use border instead
                      k === kind
                        ? css({
                          "text-decoration-line": "underline",
                          "text-underline-offset": "6px",
                          "text-decoration-thickness": "2px",
                        })
                        : ""} ${k === kind ? "text-default" : "text-gray-500"}`}
                    onClick={() => {
                      setKind(k);
                      setPage(0);
                    }}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>

            <div class="overflow-y-auto flex-grow-1">
              {results
                ? (
                  <>
                    {results.manual && (
                      <Section title="Manual" isAll={kind === "All"}>
                        {results.manual && results.manual.hits.length === 0 && (
                          <div class="text-gray-500 italic">
                            Your search did not yield any results in the manual.
                          </div>
                        )}
                        {results.manual.hits.map((res, i) => (
                          <ManualResult
                            {...res}
                            queryID={results.manual!.queryID}
                            position={getPosition(results.manual!, i)}
                          />
                        ))}
                      </Section>
                    )}
                    {results.modules && (
                      <Section title="Modules" isAll={kind === "All"}>
                        {results.modules && results.modules.hits.length === 0 &&
                          (
                            <div class="text-gray-500 italic">
                              Your search did not yield any results in the
                              modules index.
                            </div>
                          )}
                        {results.modules.hits.map((module, i) => (
                          <ModuleResult
                            module={module}
                            queryID={results.modules!.queryID}
                            position={getPosition(results.modules!, i)}
                          />
                        ))}
                      </Section>
                    )}
                    {results.symbols && (
                      <Section title="Symbols" isAll={kind === "All"}>
                        {results.symbols && results.symbols.hits.length === 0 &&
                          (
                            <div class="text-gray-500 italic">
                              Your search did not yield any results in the
                              symbol index.
                            </div>
                          )}
                        {results.symbols.hits.map((symbolItem, i) => (
                          <SymbolResult
                            queryID={results.symbols!.queryID}
                            position={getPosition(results.symbols!, i)}
                            denoVersion={denoVersion}
                          >
                            {symbolItem}
                          </SymbolResult>
                        ))}
                      </Section>
                    )}
                    <div class={tw`${kind === "All" ? "h-6" : "h-3.5"}`} />
                  </>
                )
                : (
                  <div class="w-full h-full flex justify-center items-center gap-1.5 text-gray-400">
                    <Icons.Spinner />
                    <span>Searching...</span>
                  </div>
                )}
            </div>

            {kind !== "All" && results && (
              <div class="bg-ultralight border-t border-[#E8E7E5] py-3 px-6 flex items-center justify-between">
                <div class="py-2 flex items-center space-x-3">
                  <button
                    class="p-1 border border-border rounded-md not-disabled:hover:bg-border disabled:(text-[#D2D2DC] cursor-not-allowed)"
                    onClick={() => setPage((page) => page - 1)}
                    disabled={page === 0}
                  >
                    <Icons.ChevronLeft />
                  </button>
                  <span class="text-gray-400">
                    Page <span class="font-medium">{page + 1}</span> of{" "}
                    <span class="font-medium">{totalPages}</span>
                  </span>
                  <button
                    class="p-1 border border-border rounded-md not-disabled:hover:bg-border disabled:(text-[#D2D2DC] cursor-not-allowed)"
                    onClick={() => setPage((page) => page + 1)}
                    disabled={(page + 1) === totalPages}
                  >
                    <Icons.ChevronRight />
                  </button>
                </div>

                {kind === "Symbols" &&
                  (
                    <div class="space-x-3">
                      {(Object.keys(
                        symbolKinds,
                      ) as (keyof typeof symbolKinds)[])
                        .map(
                          (symbolKind) => (
                            <label class="whitespace-nowrap inline-block">
                              <input
                                type="checkbox"
                                class="mr-1 not-checked:siblings:text-[#6C6E78]"
                                onChange={() => {
                                  setSymbolKindsToggle((prev) => {
                                    return {
                                      ...prev,
                                      [symbolKind]: !prev[symbolKind],
                                    };
                                  });
                                }}
                                checked={symbolKindsToggle[symbolKind]}
                              />
                              <span class="text-sm leading-none">
                                {symbolKind}
                              </span>
                            </label>
                          ),
                        )}
                    </div>
                  )}
              </div>
            )}
          </div>
        </dialog>
      )}
    </>
  );
}

function Section({
  title,
  isAll,
  children,
}: {
  title: string;
  isAll: boolean;
  children: ComponentChildren;
}) {
  return (
    <div class="pt-3">
      {isAll && (
        <div class="mx-6 my-1 text-gray-400 text-sm leading-6 font-semibold">
          {title}
        </div>
      )}
      <div class="children:(flex items-center gap-4 px-6 py-1.5 hover:bg-ultralight even:(bg-ultralight hover:bg-border))">
        {children}
      </div>
    </div>
  );
}

function ManualResult(
  { hierarchy, docPath, anchor, content, objectID, queryID, position }:
    & ManualSearchResult
    & {
      objectID: string;
      queryID?: string;
      position?: number;
    },
) {
  const title = Object.values(hierarchy).filter(Boolean);
  return (
    <a
      href={`${docPath}#${anchor}`}
      onClick={() =>
        islandSearchClick(MANUAL_INDEX, queryID, objectID, position)}
    >
      <div class="p-1.5 rounded-full bg-gray-200">
        <Icons.Docs />
      </div>
      <div>
        <ManualResultTitle title={title} />
        <div class="text-sm text-[#6C6E78] max-h-10 overflow-ellipsis overflow-hidden">
          {content}
        </div>
      </div>
    </a>
  );
}

function ManualResultTitle(props: { title: string[] }) {
  const parts = [];
  for (const [i, part] of props.title.entries()) {
    const isLast = i === props.title.length - 1;
    parts.push(
      <span class={isLast ? tw`font-semibold` : undefined} key={i}>
        {part}
      </span>,
    );
    if (!isLast) parts.push(<span key={i + "separator"}>{" > "}</span>);
  }
  return <div class="space-x-1">{parts}</div>;
}

/** Given a symbol item, return an href that will link to that symbol. */
function getSymbolItemHref(
  { sourceId, name, version, path, tags }: SymbolItem,
  denoVersion: string,
): string {
  if (sourceId.startsWith("lib/")) {
    return tags && tags.includes("unstable")
      ? `/api@${denoVersion}?unstable&s=${name}`
      : `/api@${denoVersion}?s=${name}`;
  } else if (sourceId === "mod/std") {
    return `/std@${version}${path}${name ? `?s=${name}` : ""}`;
  } else {
    const mod = sourceId.slice(4);
    return `/x/${mod}@${version}${path}${name ? `?s=${name}` : ""}`;
  }
}

function Source(
  { children: { sourceId, version, path } }: { children: SymbolItem },
) {
  if (sourceId.startsWith("lib/")) {
    return (
      <span class="italic text-sm text-gray-400 leading-6">
        built-in to Deno
      </span>
    );
  } else {
    const mod = sourceId.slice(4);
    return (
      <span>
        <span class="italic text-sm text-gray-400 leading-6">
          from
        </span>{" "}
        {mod}@{version}
        {path}
      </span>
    );
  }
}

const tagColors = {
  cyan: ["[#0CAFC619]", "[#0CAFC6]"],
  gray: ["gray-100", "gray-400"],
} as const;

type TagColors = keyof typeof tagColors;

function Tag(
  { children, color }: { children: ComponentChildren; color: TagColors },
) {
  const [bg, text] = tagColors[color];
  return (
    <div
      class={tw`bg-${bg} text-${text} py-1 px-2 inline-block rounded-full font-medium text-sm leading-none mr-2 font-sans`}
    >
      {children}
    </div>
  );
}

function SymbolResult(
  { children: item, queryID, position, denoVersion }: {
    children: SymbolItem & { objectID: string };
    queryID?: string;
    position?: number;
    denoVersion: string;
  },
) {
  const KindIcon = docNodeKindMap[item.kind];
  const href = getSymbolItemHref(item, denoVersion);
  const tagItems = item.tags?.map((tag) => (
    <Tag color={tag.startsWith("allow") ? "cyan" : "gray"}>{tag}</Tag>
  ));

  return (
    <a
      href={href}
      onClick={() =>
        islandSearchClick(SYMBOL_INDEX, queryID, item.objectID, position)}
    >
      <KindIcon />
      <div class="w-full">
        <div class="flex flex-col py-1 md:(flex-row items-center justify-between gap-2)">
          <div class="space-x-2">
            <span class={tw`text-[${colors[item.kind][0]}]`}>
              {item.kind.replace("A", " a")}
            </span>
            <span class="font-semibold">{item.name}</span>
            <Source>{item}</Source>
          </div>
          {tagItems && tagItems.length && <div class="mr-3">{tagItems}</div>}
        </div>
        {item.doc && (
          <div class="text-sm text-[#6C6E78]">
            {item.doc.split("\n\n")[0]}
          </div>
        )}
      </div>
    </a>
  );
}

function ModuleResult(
  { module, queryID, position }: {
    module: ModuleSearchResult & { objectID: string };
    queryID?: string;
    position?: number;
  },
) {
  return (
    <a
      href={`https://deno.land/x/${module.name}`}
      onClick={() =>
        islandSearchClick(MODULE_INDEX, queryID, module.objectID, position)}
    >
      <div class="p-1.5 rounded-full bg-gray-200">
        <Icons.Module />
      </div>
      <div>
        <div class="font-semibold">{module.name}</div>
        <div class="text-sm text-[#6C6E78] max-h-10 overflow-ellipsis overflow-hidden">
          {module.description}
        </div>
      </div>
    </a>
  );
}
