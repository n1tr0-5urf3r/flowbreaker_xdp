package engine

import (
	"container/list"
	"sync"

	"flowbreaker/internal/flow"
)

// registry maps flow IDs back to kernel keys. It is a bounded LRU so a busy
// host cannot grow it without limit.
type registry struct {
	mu    sync.Mutex
	max   int
	order *list.List // front = most recently used; values are string IDs
	byID  map[string]regEntry
}

type regEntry struct {
	key  flow.Key
	elem *list.Element
}

func newRegistry(max int) *registry {
	return &registry{max: max, order: list.New(), byID: make(map[string]regEntry)}
}

func (r *registry) put(k flow.Key) string {
	id := flow.ID(k)
	r.mu.Lock()
	defer r.mu.Unlock()
	if e, ok := r.byID[id]; ok {
		r.order.MoveToFront(e.elem)
		return id
	}
	r.byID[id] = regEntry{key: k, elem: r.order.PushFront(id)}
	for r.order.Len() > r.max {
		old := r.order.Back()
		r.order.Remove(old)
		delete(r.byID, old.Value.(string))
	}
	return id
}

func (r *registry) get(id string) (flow.Key, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.byID[id]
	if ok {
		r.order.MoveToFront(e.elem)
	}
	return e.key, ok
}
