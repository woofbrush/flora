/**
 * Tables and lists.
 *
 * One table implementation for accounts, proxies and logs. It owns the things
 * that are easy to get subtly wrong and tedious to repeat: the header checkbox's
 * indeterminate state, keeping a sort stable, and not re-rendering the whole
 * body when a single row changes.
 *
 * Rows are built from a `key` so a redraw can reuse the existing element. That
 * matters most for the accounts table: a bot logging in changes one row, and
 * rebuilding a thousand would drop the scroll position and the focused element.
 */
import { h, fill, fragment } from '../dom.js';
import { icon } from '../icons.js';

/** A checkbox that reports indeterminate correctly and stays accessible. */
export function checkbox({ checked = false, indeterminate = false, onChange = null, label = null, disabled = false } = {}) {
  const input = h('input.checkbox', {
    type: 'checkbox',
    checked,
    disabled,
    'aria-label': label ?? undefined
  });
  input.indeterminate = Boolean(indeterminate) && !checked;
  if (onChange) input.addEventListener('change', () => onChange(input.checked, input));
  return input;
}

/**
 * A header checkbox that reflects the selection beneath it.
 *
 * Three states, not two: none, some, all. Collapsing "some" into "none" is how
 * a bulk action ends up applying to nothing when the user thought it applied to
 * everything.
 */
export function triCheckbox({ total, selected, onToggle, label = 'Select all' }) {
  const input = checkbox({
    checked: total > 0 && selected === total,
    indeterminate: selected > 0 && selected < total,
    disabled: total === 0,
    label,
    onChange: (checked) => onToggle(checked)
  });
  return input;
}

/**
 * Build a table.
 *
 * `columns` is `[{ key, label, width, align, sortable, render(row), cellClass }]`.
 * `render` returns a node or a string; when it is missing, `row[key]` is shown.
 *
 * `sort` is `{ key, dir }` and `onSort(key)` is called when a sortable header is
 * clicked - the caller owns the ordering, because for accounts it is a database
 * query rather than an array sort.
 */
export function dataTable({
  columns,
  rows,
  rowKey = (row) => row.id,
  onRowClick = null,
  selectable = false,
  selection = null,
  onSelect = null,
  onSelectAll = null,
  sort = null,
  onSort = null,
  empty = null,
  rowClass = null,
  rowAttrs = null,
  footer = null
}) {
  const head = h('tr');
  const body = h('tbody');

  if (selectable) {
    const all = triCheckbox({
      total: rows.length,
      selected: selection?.size ?? 0,
      onToggle: (checked) => onSelectAll?.(checked)
    });
    head.appendChild(h('th.col-check', [all]));
  }

  for (const column of columns) {
    const isSorted = sort?.key === column.key;
    const th = h('th', {
      class: [
        column.sortable ? 'sortable' : null,
        column.align === 'right' ? 'right' : null,
        column.align === 'center' ? 'center' : null,
        column.cellClass ?? null
      ].filter(Boolean).join(' ') || null,
      style: column.width ? { width: column.width } : null,
      // The stylesheet keys the arrow's visibility off this attribute.
      dataset: isSorted ? { sort: sort.dir } : null,
      'aria-sort': isSorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : (column.sortable ? 'none' : null),
      onclick: column.sortable && onSort ? () => onSort(column.key) : null
    }, [
      h('span', column.label ?? ''),
      column.sortable
        ? h('span.sortmark', { 'aria-hidden': 'true' }, isSorted ? (sort.dir === 'asc' ? '▲' : '▼') : '▲')
        : null
    ]);
    head.appendChild(th);
  }

  const table = h('table.table', [
    h('thead', [head]),
    body
  ]);

  renderRows({ body, rows, columns, rowKey, onRowClick, selectable, selection, onSelect, rowClass, rowAttrs });

  if (!rows.length && empty) {
    return h('div', [table, empty]);
  }

  return footer ? h('div', [table, footer]) : table;
}

/**
 * (Re)fill a table body.
 *
 * Exposed so a view can update rows in place after an event, without going back
 * through `dataTable` and rebuilding the header.
 */
export function renderRows({ body, rows, columns, rowKey, onRowClick, selectable, selection, onSelect, rowClass, rowAttrs }) {
  const cells = [];
  const seen = new Set();

  for (const row of rows) {
    const key = rowKey(row);
    seen.add(String(key));

    const check = selectable
      ? h('td.col-check', [
          checkbox({
            checked: selection?.has(Number(key)) ?? false,
            label: `Select ${row.username ?? key}`,
            onChange: (checked, input) => {
              input.indeterminate = false;
              onSelect?.(key, checked);
            }
          })
        ])
      : null;

    const tds = columns.map((column) => {
      const content = column.render ? column.render(row) : row[column.key];
      return h('td', {
        class: [
          column.align === 'right' ? 'right' : null,
          column.align === 'center' ? 'center' : null,
          column.cellClass ?? null
        ].filter(Boolean).join(' ') || null
      }, content ?? '');
    });

    const tr = h('tr', {
      // The stylesheet highlights a selected row from this attribute, so
      // selection reads the same whether it came from a click or a bulk action.
      dataset: {
        key: String(key),
        ...(selectable && selection?.has(Number(key)) ? { selected: 'true' } : {}),
        ...(rowAttrs?.(row) ?? {})
      },
      class: rowClass?.(row) ?? null,
      onclick: onRowClick
        ? (event) => {
            // A click on a control in the row is that control's, not the row's.
            if (event.target.closest('button, input, a, select, [role="menu"]')) return;
            onRowClick(row, event);
          }
        : null
    }, [check, ...tds]);

    cells.push(tr);
  }

  fill(body, fragment(cells));
  return body;
}

/**
 * A percentage meter with a label.
 *
 * `total` of 0 means "unknown", which renders as an indeterminate bar rather
 * than as 100% - a full bar for an unfinished job is a lie.
 */
export function progress({ done = 0, total = 0, tone = null, label = null, thin = false } = {}) {
  const known = total > 0;
  const percent = known ? Math.min(100, Math.round((done / total) * 100)) : 0;

  const bar = h('div.progress__bar', { style: { width: known ? `${percent}%` : null } });
  const track = h(`div.progress${thin ? '.progress--thin' : ''}${tone ? `.progress--${tone}` : ''}`, {
    role: 'progressbar',
    // The stylesheet animates the bar from this attribute; the class variant
    // would collide with the keyframes it already defines.
    dataset: known ? null : { indeterminate: 'true' },
    'aria-valuenow': known ? percent : null,
    'aria-valuemin': '0',
    'aria-valuemax': '100'
  }, [bar]);

  return label
    ? h('div', [
        h('div.row', { style: { justifyContent: 'space-between', marginBottom: '6px' } }, [
          h('span.muted', label),
          h('span.mono-sm', known ? `${done} / ${total}` : `${done}`)
        ]),
        track
      ])
    : track;
}

/** The shared "nothing here yet" block. */
export function emptyState({ icon: name = 'folder', title, body = null, action = null }) {
  return h('div.empty', [
    h('div.empty__art', [icon(name, { size: 26 })]),
    h('h3', title),
    body ? h('p', body) : null,
    action ? h('div', { style: { marginTop: '14px' } }, [action]) : null
  ]);
}

/** A muted placeholder shown while a first load is in flight. */
export function skeletonRows(count = 6, height = 44) {
  return h('div', { style: { padding: '16px 0' } },
    Array.from({ length: count }, () => h('div.skeleton', {
      style: { height: `${height}px`, marginBottom: '8px', borderRadius: 'var(--r-sm)' }
    }))
  );
}

/**
 * Sort helper for in-memory lists (proxies, logs).
 *
 * The accounts table sorts in SQL instead, because sorting a page of a thousand
 * rows in the renderer means fetching them all first.
 */
export function sortRows(rows, key, dir, accessor = null) {
  const value = accessor ?? ((row) => row[key]);
  const sign = dir === 'desc' ? -1 : 1;

  return [...rows].sort((a, b) => {
    const left = value(a);
    const right = value(b);

    if (left == null && right == null) return 0;
    if (left == null) return 1;          // missing values sink, in both directions
    if (right == null) return -1;

    if (typeof left === 'number' && typeof right === 'number') return (left - right) * sign;
    return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' }) * sign;
  });
}
