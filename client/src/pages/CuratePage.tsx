import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Eye, EyeOff, ListPlus } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'

// Feature 002-model-curation-layer: curated lists — build, browse the builtin
// catalog of lists, apply to a catalog source, toggle per-model in/out.
// Criteria are STATIC; membership is evaluated LIVE server-side.

interface Criteria {
  free_only?: boolean
  max_cost_input?: number
  min_context?: number
  tool_call?: boolean
  input_image?: boolean
  open_weights?: boolean
}

interface CuratedList {
  id: number
  name: string
  description: string
  criteria: Criteria
  is_builtin: boolean
  match_count: number
}

interface ModelSource {
  id: number
  name: string
  kind: 'builtin' | 'url' | 'catalog'
  enabled: boolean
  active_list_id: number | null
}

interface CatalogModel {
  platform: string
  model_id: string
  display_name: string
  context_window: number | null
  curated_in: boolean
  override: 'include' | 'exclude' | null
  metadata: {
    cost_input: number | null
    cost_output: number | null
    context_limit: number | null
    tool_call: boolean | null
    open_weights: boolean | null
  } | null
}

function fmtCost(v: number | null | undefined): string {
  if (v === null || v === undefined) return '?'
  return v === 0 ? 'free' : `$${v.toFixed(2)}`
}

function fmtCtx(v: number | null | undefined): string {
  if (v === null || v === undefined) return '?'
  return `${Math.round(v / 1000)}k`
}

export default function CuratePage() {
  const queryClient = useQueryClient()
  const [selectedListId, setSelectedListId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [includedTab, setIncludedTab] = useState<'all' | 'in' | 'out'>('all')
  const [sort, setSort] = useState('-context')
  // builder state (custom list creation / preview)
  const [builderOpen, setBuilderOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [bFreeOnly, setBFreeOnly] = useState(false)
  const [bToolCall, setBToolCall] = useState(false)
  const [bImage, setBImage] = useState(false)
  const [bOpenWeights, setBOpenWeights] = useState(false)
  const [bMinContext, setBMinContext] = useState('')

  const builderCriteria: Criteria = {
    ...(bFreeOnly ? { free_only: true } : {}),
    ...(bToolCall ? { tool_call: true } : {}),
    ...(bImage ? { input_image: true } : {}),
    ...(bOpenWeights ? { open_weights: true } : {}),
    ...(bMinContext ? { min_context: Number(bMinContext) } : {}),
  }

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['curated-lists'] })
    queryClient.invalidateQueries({ queryKey: ['curate-models'] })
    queryClient.invalidateQueries({ queryKey: ['sources'] })
    queryClient.invalidateQueries({ queryKey: ['models'] })
  }

  const { data: listsData } = useQuery({
    queryKey: ['curated-lists'],
    queryFn: () => apiFetch<{ lists: CuratedList[] }>('/api/curated-lists'),
  })

  const { data: sourcesData } = useQuery({
    queryKey: ['sources'],
    queryFn: () => apiFetch<{ sources: ModelSource[] }>('/api/sources'),
  })

  const catalogSources = (sourcesData?.sources ?? []).filter(s => s.kind === 'catalog')
  const [applySourceId, setApplySourceId] = useState<string>('')
  const effectiveApplySourceId = applySourceId || String(catalogSources[0]?.id ?? '')

  const { data: previewData } = useQuery({
    queryKey: ['curate-preview', JSON.stringify(builderCriteria)],
    queryFn: () =>
      apiFetch<{ match_count: number; sample: unknown[] }>('/api/curated-lists/preview', {
        method: 'POST',
        body: JSON.stringify({ criteria: builderCriteria }),
      }),
    enabled: builderOpen,
  })

  const createList = useMutation({
    mutationFn: (body: { name: string; criteria: Criteria }) =>
      apiFetch('/api/curated-lists', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      setBuilderOpen(false)
      setNewName('')
      invalidateAll()
    },
  })

  const deleteList = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/curated-lists/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setSelectedListId(null)
      invalidateAll()
    },
  })

  const applyList = useMutation({
    mutationFn: ({ sourceId, listId }: { sourceId: number; listId: number | null }) =>
      apiFetch(`/api/sources/${sourceId}`, {
        method: 'PATCH',
        body: JSON.stringify({ active_list_id: listId }),
      }),
    onSuccess: invalidateAll,
  })

  const { data: modelsData, isLoading: modelsLoading } = useQuery({
    queryKey: ['curate-models', selectedListId, search, includedTab, sort],
    queryFn: () => {
      const params = new URLSearchParams({
        search,
        included: includedTab,
        sort,
        per_page: '100',
      })
      return apiFetch<{ total: number; models: CatalogModel[] }>(
        `/api/curated-lists/${selectedListId}/models?${params}`,
      )
    },
    enabled: selectedListId !== null,
  })

  const setOverride = useMutation({
    mutationFn: (body: { platform: string; model_id: string; decision: 'include' | 'exclude' | null }) =>
      apiFetch(`/api/curated-lists/${selectedListId}/models`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: invalidateAll,
  })

  const lists = listsData?.lists ?? []
  const builtins = lists.filter(l => l.is_builtin)
  const custom = lists.filter(l => !l.is_builtin)
  const selectedList = lists.find(l => l.id === selectedListId)

  return (
    <div className="space-y-6">
      <PageHeader title="Curate" description="Curated model lists — static filters, live membership. Apply a list to a catalog source to shape what /v1/models exposes." />

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Builtin catalog */}
        <div className="rounded-lg border p-4 space-y-3">
          <h2 className="text-sm font-medium flex items-center gap-2">
            <ListPlus className="size-4" /> Built-in curated lists
          </h2>
          <div className="space-y-2">
            {builtins.map(l => (
              <button
                key={l.id}
                onClick={() => setSelectedListId(l.id)}
                className={`w-full text-left rounded-md border p-3 hover:bg-accent transition-colors ${selectedListId === l.id ? 'border-primary' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{l.name}</span>
                  <Badge variant="secondary">{l.match_count} models</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{l.description}</p>
              </button>
            ))}
          </div>
        </div>

        {/* My lists + builder */}
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">My curated lists</h2>
            <Button variant="outline" size="sm" onClick={() => setBuilderOpen(!builderOpen)}>
              <Plus className="size-4" /> New list
            </Button>
          </div>
          <div className="space-y-2">
            {custom.length === 0 && (
              <p className="text-sm text-muted-foreground">No custom lists yet.</p>
            )}
            {custom.map(l => (
              <button
                key={l.id}
                onClick={() => setSelectedListId(l.id)}
                className={`w-full text-left rounded-md border p-3 hover:bg-accent transition-colors ${selectedListId === l.id ? 'border-primary' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{l.name}</span>
                  <Badge variant="outline">{l.match_count} models</Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Delete ${l.name}`}
                    onClick={e => {
                      e.stopPropagation()
                      if (window.confirm(`Delete "${l.name}"?`)) deleteList.mutate(l.id)
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </button>
            ))}
          </div>

          {builderOpen && (
            <div className="rounded-md border p-3 space-y-3 bg-muted/30">
              <div className="space-y-1">
                <Label htmlFor="cl-name">Name</Label>
                <Input id="cl-name" value={newName} onChange={e => setNewName(e.target.value)} placeholder="My free vision models" />
              </div>
              <div className="flex flex-wrap gap-3 text-sm">
                <label className="flex items-center gap-1"><input type="checkbox" checked={bFreeOnly} onChange={e => setBFreeOnly(e.target.checked)} /> Free only</label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={bToolCall} onChange={e => setBToolCall(e.target.checked)} /> Tool call</label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={bImage} onChange={e => setBImage(e.target.checked)} /> Image input</label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={bOpenWeights} onChange={e => setBOpenWeights(e.target.checked)} /> Open weights</label>
                <label className="flex items-center gap-1">
                  Min context
                  <Input type="number" value={bMinContext} onChange={e => setBMinContext(e.target.value)} placeholder="100000" className="h-7 w-28" />
                </label>
              </div>
              <p className="text-sm text-muted-foreground">
                Live preview: matches{' '}
                <span className="font-medium text-foreground">{previewData?.match_count ?? '…'}</span> current catalog models
              </p>
              <Button
                size="sm"
                disabled={!newName.trim() || Object.keys(builderCriteria).length === 0 || createList.isPending}
                onClick={() => createList.mutate({ name: newName, criteria: builderCriteria })}
              >
                Create list
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Apply to source */}
      {selectedList && catalogSources.length > 0 && (
        <div className="rounded-lg border p-4 space-y-3">
          <h2 className="text-sm font-medium">Apply “{selectedList.name}” to a catalog source</h2>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="apply-source">Catalog source</Label>
              <select
                id="apply-source"
                value={effectiveApplySourceId}
                onChange={e => setApplySourceId(e.target.value)}
                className="h-9 rounded-md border bg-transparent px-2 text-sm"
              >
                {catalogSources.map(s => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name}{s.active_list_id ? ` (currently: list #${s.active_list_id})` : ' (no list)'}
                  </option>
                ))}
              </select>
            </div>
            <Button
              onClick={() => applyList.mutate({ sourceId: Number(effectiveApplySourceId), listId: selectedList.id })}
              disabled={!effectiveApplySourceId || applyList.isPending}
            >
              Use this list
            </Button>
          </div>
        </div>
      )}

      {/* Model browser */}
      {selectedListId !== null && (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-medium">Models in “{selectedList?.name}”</h2>
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" className="h-8 w-48" />
            <select value={sort} onChange={e => setSort(e.target.value)} className="h-8 rounded-md border bg-transparent px-2 text-sm">
              <option value="-context">Context ↓</option>
              <option value="context">Context ↑</option>
              <option value="price">Price ↑</option>
              <option value="-price">Price ↓</option>
              <option value="name">Name A–Z</option>
            </select>
            <div className="ms-auto flex gap-1">
              {(['all', 'in', 'out'] as const).map(tab => (
                <Button key={tab} variant={includedTab === tab ? 'default' : 'ghost'} size="sm" onClick={() => setIncludedTab(tab)}>
                  {tab === 'all' ? 'All' : tab === 'in' ? 'Included' : 'Excluded'}
                </Button>
              ))}
            </div>
          </div>

          {modelsLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pe-4">Model</th>
                    <th className="py-2 pe-4">In $/Mtok</th>
                    <th className="py-2 pe-4">Out $/Mtok</th>
                    <th className="py-2 pe-4">Context</th>
                    <th className="py-2 pe-4">State</th>
                    <th className="py-2">Toggle</th>
                  </tr>
                </thead>
                <tbody>
                  {(modelsData?.models ?? []).map(m => (
                    <tr key={`${m.platform}/${m.model_id}`} className="border-b last:border-0">
                      <td className="py-2 pe-4 font-mono">{m.platform}/{m.display_name}</td>
                      <td className="py-2 pe-4">{fmtCost(m.metadata?.cost_input)}</td>
                      <td className="py-2 pe-4">{fmtCost(m.metadata?.cost_output)}</td>
                      <td className="py-2 pe-4">{fmtCtx(m.context_window)}</td>
                      <td className="py-2 pe-4">
                        {m.curated_in
                          ? <Badge variant="secondary">in</Badge>
                          : <Badge variant="destructive">out</Badge>}
                        {m.override && <Badge variant="outline" className="ms-1">{m.override}</Badge>}
                      </td>
                      <td className="py-2">
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Include ${m.model_id}`}
                            disabled={m.override === 'include'}
                            onClick={() => m.platform && setOverride.mutate({ platform: m.platform, model_id: m.model_id, decision: 'include' })}
                          >
                            <Eye className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Exclude ${m.model_id}`}
                            disabled={m.override === 'exclude'}
                            onClick={() => m.platform && setOverride.mutate({ platform: m.platform, model_id: m.model_id, decision: 'exclude' })}
                          >
                            <EyeOff className="size-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-muted-foreground mt-2">
                Showing {(modelsData?.models ?? []).length} of {modelsData?.total ?? 0}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
