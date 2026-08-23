import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RefreshCw, Trash2, Power, Pencil } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'

// Feature 001-model-sources-crud: visible, editable list of where models
// are pulled from. Builtin catalog + operator URL sources.

interface ModelSource {
  id: number
  name: string
  kind: 'builtin' | 'url'
  location: string
  enabled: boolean
  last_synced_at: string | null
  last_sync_status: 'ok' | 'error' | 'never'
  last_error: string | null
  model_count: number
}

interface SourcesResponse {
  sources: ModelSource[]
}

function statusBadge(s: ModelSource) {
  if (!s.enabled) return <Badge variant="outline">disabled</Badge>
  switch (s.last_sync_status) {
    case 'ok':
      return <Badge variant="secondary">ok</Badge>
    case 'error':
      return <Badge variant="destructive">error</Badge>
    default:
      return <Badge variant="outline">never synced</Badge>
  }
}

export default function SourcesPage() {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editLocation, setEditLocation] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['sources'],
    queryFn: () => apiFetch<SourcesResponse>('/api/sources'),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['sources'] })
    queryClient.invalidateQueries({ queryKey: ['models'] })
  }

  const addSource = useMutation({
    mutationFn: (body: { name: string; location: string }) =>
      apiFetch('/api/sources', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      setName('')
      setLocation('')
      setFormError(null)
      invalidate()
    },
    onError: (err: Error) => setFormError(err.message),
  })

  const syncSource = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/sources/${id}/sync`, { method: 'POST' }),
    onSuccess: invalidate,
    onError: () => invalidate(), // failure also updates the source row
  })

  const toggleSource = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiFetch(`/api/sources/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: invalidate,
  })

  const deleteSource = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/sources/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })

  const saveEdit = useMutation({
    mutationFn: ({ id, name, location }: { id: number; name: string; location: string }) =>
      apiFetch(`/api/sources/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, location }),
      }),
    onSuccess: () => {
      setEditingId(null)
      invalidate()
    },
  })

  const sources = data?.sources ?? []

  return (
    <div className="space-y-6">
      <PageHeader title="Model Sources" description="Where your models come from — the built-in catalog plus any custom lists you add." />

      <div className="rounded-lg border p-4 space-y-3">
        <h2 className="text-sm font-medium">Add a source</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="src-name">Name</Label>
            <Input id="src-name" value={name} onChange={e => setName(e.target.value)} placeholder="My model list" />
          </div>
          <div className="space-y-1 grow min-w-64">
            <Label htmlFor="src-url">URL (JSON model list)</Label>
            <Input id="src-url" value={location} onChange={e => setLocation(e.target.value)} placeholder="https://example.com/models.json" />
          </div>
          <Button
            onClick={() => addSource.mutate({ name, location })}
            disabled={!name.trim() || !location.trim() || addSource.isPending}
          >
            <Plus className="size-4" /> Add source
          </Button>
        </div>
        {formError && <p className="text-sm text-destructive">{formError}</p>}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-3">
          {sources.map(s => (
            <div key={s.id} className="rounded-lg border p-4 space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium">{s.name}</span>
                <Badge variant="outline">{s.kind}</Badge>
                {statusBadge(s)}
                <span className="text-sm text-muted-foreground">
                  {s.model_count} model{s.model_count === 1 ? '' : 's'}
                  {s.last_synced_at ? ` · last sync ${new Date(s.last_synced_at).toLocaleString()}` : ''}
                </span>
                <div className="ms-auto flex items-center gap-2">
                  {s.kind === 'url' && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => syncSource.mutate(s.id)} disabled={syncSource.isPending}>
                        <RefreshCw className="size-4" /> Sync now
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Disable or enable ${s.name}`}
                        onClick={() => toggleSource.mutate({ id: s.id, enabled: !s.enabled })}
                      >
                        <Power className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Edit ${s.name}`}
                        onClick={() => {
                          setEditingId(editingId === s.id ? null : s.id)
                          setEditName(s.name)
                          setEditLocation(s.location)
                        }}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete ${s.name}`}
                        onClick={() => {
                          if (window.confirm(`Delete "${s.name}" and its exclusively-owned models?`)) {
                            deleteSource.mutate(s.id)
                          }
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <p className="text-sm text-muted-foreground break-all">{s.location || '(built-in upstream catalog)'}</p>
              {s.last_error && <p className="text-sm text-destructive">Last error: {s.last_error}</p>}
              {editingId === s.id && (
                <div className="flex flex-wrap items-end gap-3 border-t pt-3 mt-2">
                  <div className="space-y-1">
                    <Label htmlFor={`edit-name-${s.id}`}>Name</Label>
                    <Input id={`edit-name-${s.id}`} value={editName} onChange={e => setEditName(e.target.value)} />
                  </div>
                  <div className="space-y-1 grow min-w-64">
                    <Label htmlFor={`edit-url-${s.id}`}>URL</Label>
                    <Input id={`edit-url-${s.id}`} value={editLocation} onChange={e => setEditLocation(e.target.value)} />
                  </div>
                  <Button size="sm" onClick={() => saveEdit.mutate({ id: s.id, name: editName, location: editLocation })}>
                    Save
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
