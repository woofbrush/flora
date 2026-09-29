/**
 * Import accounts.
 *
 * Three steps in one dialog, because the middle one is the whole reason this is
 * a dialog rather than a menu item: a file is parsed and *staged* before
 * anything is written, so the numbers - how many are usable, how many are
 * duplicates, which lines could not be read - can be shown and accepted first.
 *
 * A dropped file is read with the File API rather than by path, which means the
 * import works without the preload exposing a filesystem path.
 */
import { h, fill } from '../dom.js';
import { icon, hydrate } from '../icons.js';
import * as bridge from '../bridge.js';
import * as store from '../store.js';
import * as format from '../format.js';
import * as toast from '../components/toast.js';
import { modal } from '../components/overlay.js';
import { progress } from '../components/table.js';
import { field } from './shell.js';
import { openImportHelp } from './helpDialog.js';

const KIND_LABEL = { token: 'Token', offline: 'Offline' };
const KIND_TONE = { token: 'info', offline: 'idle' };

const MAX_BYTES = 32 * 1024 * 1024;

/** The window refuses a file dropped outside the drop zone, or Electron navigates to it. */
let dropGuardInstalled = false;
function installDropGuard() {
  if (dropGuardInstalled) return;
  dropGuardInstalled = true;
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
}

export function openImportDialog() {
  installDropGuard();

  /** The staged import awaiting confirmation, or null. */
  let staged = null;
  /** The last text that was read, so "back" does not lose a pasted list. */
  let source = '';

  const dialog = modal({
    title: 'Import accounts',
    subtitle: 'From a .txt, .csv or .json file.',
    size: 'wide',
    onClose: () => {
      // A staged import that is never confirmed is dropped rather than left
      // occupying memory in the backend for the next half hour.
      if (staged?.stageId) bridge.invoke('import.discard', { stageId: staged.stageId }).catch(() => {});
    },
    // A footer has to exist for `setFooter` to work; every step replaces it.
    actions: [{ label: 'Cancel' }]
  });

  // ------------------------------------------------------------ step 1

  function stepChoose() {
    staged = null;

    const textarea = h('textarea', {
      placeholder: 'Or paste a list here, one account per line…',
      spellcheck: 'false',
      rows: '6',
      value: source
    });

    const preview = h('button.btn.btn--primary', {
      type: 'button',
      disabled: !source.trim(),
      onclick: () => stage(textarea.value, '')
    }, 'Preview');

    textarea.addEventListener('input', () => { preview.disabled = !textarea.value.trim(); });

    const zone = h('div', {
      style: {
        display: 'grid',
        justifyItems: 'center',
        gap: '8px',
        padding: '26px 18px',
        border: '1px dashed var(--surface2)',
        borderRadius: 'var(--r-md)',
        background: 'var(--crust)',
        textAlign: 'center',
        transition: 'border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease)'
      }
    }, [
      icon('file-plus-02', { size: 26 }),
      h('b', 'Drop an account file here'),
      h('span.muted', { style: { fontSize: 'var(--fs-sm)' } }, 'or'),
      h('button.btn.btn--outline.btn--sm', { type: 'button', onclick: () => chooseFile() }, [
        icon('folder', { size: 14 }), 'Choose a file…'
      ])
    ]);

    const stop = (event) => { event.preventDefault(); event.stopPropagation(); };

    zone.addEventListener('dragover', (event) => {
      stop(event);
      zone.style.borderColor = 'var(--accent)';
      zone.style.background = 'var(--accent-soft)';
    });

    zone.addEventListener('dragleave', (event) => {
      stop(event);
      zone.style.borderColor = '';
      zone.style.background = '';
    });

    zone.addEventListener('drop', async (event) => {
      stop(event);
      zone.style.borderColor = '';
      zone.style.background = '';

      // The drop guard fires on the window; this handler has to win first, and
      // `stopPropagation` above is what makes that true.
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      if (file.size > MAX_BYTES) {
        toast.warn('That file is too large', `The limit is ${format.bytes(MAX_BYTES)}.`);
        return;
      }
      try {
        await stage(await file.text(), file.name);
      } catch (err) {
        toast.fromError(err, 'Could not read that file');
      }
    });

    dialog.setBody(h('div', [
      zone,
      h('hr.divider'),
      textarea,
      h('div.row', { style: { justifyContent: 'space-between', marginTop: '10px', gap: '10px' } }, [
        h('span.muted', { style: { fontSize: 'var(--fs-sm)' } },
          'Tokens, usernames, email:password and JSON are all recognised.'),
        h('button.btn.btn--ghost.btn--sm', { type: 'button', onclick: () => openImportHelp() }, [
          icon('help-circle', { size: 14 }), 'Which formats?'
        ])
      ])
    ]));

    dialog.setFooter([
      h('div.grow.muted', { style: { fontSize: 'var(--fs-sm)' } }, 'Nothing is written until you confirm it.'),
      h('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      preview
    ]);

    hydrate(dialog.element);
  }

  async function chooseFile() {
    try {
      const file = await bridge.ui.openAccountsFile();
      if (file?.cancelled) return;
      await stage(file.text, file.name);
    } catch (err) {
      toast.fromError(err, 'Could not read that file');
    }
  }

  // ------------------------------------------------------------ step 2

  async function stage(text, name) {
    if (!String(text ?? '').trim()) {
      toast.warn('Nothing to import', 'That was empty.');
      return;
    }

    dialog.setBody(h('div.loading-block', [h('span.spinner'), 'Reading the file…']));
    dialog.setFooter([]);

    try {
      const result = await bridge.invoke('import.prepare', { text, filename: name });
      if (!result?.ok) {
        dialog.setBody(h('div', [
          h('div.callout.callout--danger', [
            icon('alert-circle', { size: 15 }),
            h('div', [h('b', 'That file could not be read'), h('p', result?.error ?? 'No reason given.')])
          ]),
          h('div', { style: { marginTop: '14px' } }, [
            h('button.btn', { type: 'button', onclick: () => stepChoose() }, 'Try another file')
          ])
        ]));
        hydrate(dialog.element);
        return;
      }

      staged = result;
      source = text;
      stepPreview(name);
    } catch (err) {
      stepChoose();
      toast.fromError(err, 'Could not read that file');
    }
  }

  function stepPreview(name) {
    const { counts, sample, duplicates, invalid, truncated } = staged;

    const labelField = field({
      label: 'Label (optional)',
      control: h('input.input', { type: 'text', placeholder: 'e.g. main alt list' })
    });

    const verifyBox = h('input', { type: 'checkbox' });

    const stat = (label, value, tone = null) => h('div.stat', [
      h('div.stat__label', label),
      h(`div.stat__value${tone ? `.stat--${tone}` : ''}`, format.num(value))
    ]);

    const tags = h('div.row', { style: { gap: '6px', flexWrap: 'wrap', marginTop: '8px' } }, [
      counts.tokens ? h('span.tag', `${format.num(counts.tokens)} with a token`) : null,
      counts.offline ? h('span.tag', `${format.num(counts.offline)} offline-mode`) : null,
      counts.duplicates ? h('span.tag', `${format.num(counts.duplicates)} duplicate`) : null,
      counts.invalid ? h('span.tag', `${format.num(counts.invalid)} unreadable`) : null
    ]);

    const sampleTable = sample.length
      ? h('table.table', [
          h('thead', [h('tr', [
            h('th', { style: { width: '52px' } }, 'Line'),
            h('th', { style: { width: '88px' } }, 'Kind'),
            h('th', null, 'Account'),
            h('th', { style: { width: '150px' } }, 'Secret')
          ])]),
          h('tbody', sample.map((entry) => h('tr', [
            h('td.mono-sm.muted', format.num(entry.line)),
            h('td', [h(`span.badge.badge--${KIND_TONE[entry.kind] ?? 'idle'}`, KIND_LABEL[entry.kind] ?? entry.kind)]),
            h('td', [
              h('div.account-cell__text', [
                h('b', entry.username || 'unnamed'),
                entry.uuid ? h('span', format.truncateMiddle(entry.uuid, 8, 4)) : null
              ])
            ]),
            h('td.mono-sm.muted', entry.masked ?? '—')
          ])))
        ])
      : null;

    const problemList = (title, rows, render) => (rows.length
      ? h('div', { style: { marginTop: '16px' } }, [
          h('div.section-title', title),
          h('div', { style: { display: 'grid', gap: '3px' } }, rows.slice(0, 10).map((row) => h('div.row', {
            style: { gap: '8px', fontSize: 'var(--fs-sm)' }
          }, [
            h('span.mono-sm.muted', { style: { width: '46px', flex: 'none' } }, `Line ${row.line}`),
            h('span.grow.truncate', render(row)),
            h('span.muted', { style: { fontSize: 'var(--fs-xs)' } }, row.reason ?? '')
          ])))
        ])
      : null);

    dialog.setBody(h('div', [
      h('div.grid.grid--4', { style: { marginBottom: '14px' } }, [
        stat('Ready to import', counts.importable, counts.importable ? 'accent' : null),
        stat('Read from file', counts.total),
        stat('Duplicates', counts.duplicates),
        stat('Unreadable', counts.invalid)
      ]),

      counts.importable
        ? h('div.callout.callout--ok', [
            icon('check-circle', { size: 15 }),
            h('div', [
              h('b', `${format.plural(counts.importable, 'account')} ready`),
              name ? h('div.muted', { style: { fontSize: 'var(--fs-xs)' } }, name) : null,
              tags
            ])
          ])
        : h('div.callout.callout--warn', [
            icon('alert-triangle', { size: 15 }),
            h('div', [
              h('b', 'Nothing new to import'),
              h('p', counts.duplicates
                ? 'Every account in that file is already in flora.'
                : 'No line in that file could be read.')
            ])
          ]),

      sampleTable ? h('div', { style: { marginTop: '16px' } }, [
        h('div.section-title', truncated
          ? `First ${sample.length} of ${format.num(counts.importable)}`
          : 'What will be imported'),
        sampleTable
      ]) : null,

      problemList('Skipped - already here or repeated in the file', duplicates, (row) => row.hint ?? '—'),
      problemList('Skipped - could not be read', invalid, (row) => row.text ?? '—'),

      h('hr.divider'),
      labelField.el,
      h('div.switchfield', [
        h('div.switchfield__text', [
          h('b', 'Check each account after importing'),
          h('span', 'Slower, but it names any whose token has already expired.')
        ]),
        h('label.toggle', [verifyBox, h('span')])
      ])
    ]));

    dialog.setFooter([
      h('button.btn.btn--ghost', { type: 'button', onclick: () => stepChoose() }, [
        icon('arrow-left', { size: 14 }), 'Back'
      ]),
      h('div.spacer'),
      h('span.muted', { style: { fontSize: 'var(--fs-sm)' } },
        counts.importable ? `${format.plural(counts.importable, 'account')} will be added.` : 'Nothing to add.'),
      h('button.btn.btn--primary', {
        type: 'button',
        disabled: !counts.importable,
        onclick: () => runImport(labelField.control.value.trim(), verifyBox.checked)
      }, [icon('download-01', { size: 15 }), 'Import'])
    ]);

    hydrate(dialog.element);
  }

  // ------------------------------------------------------------ step 3

  async function runImport(label, verify) {
    const bar = h('div');

    dialog.setBody(h('div', [
      h('div.loading-block', [h('span.spinner'), 'Writing accounts…']),
      h('div', { style: { marginTop: '16px' } }, [bar])
    ]));
    dialog.setFooter([]);

    // The progress event carries no total of its own, so the count from the
    // preview is what the bar measures against until the first event lands.
    const expected = staged.counts.importable;
    const unsubscribe = store.subscribe(store.TOPICS.BUSY, (payload) => {
      if (payload?.event !== 'accounts:import-progress') return;
      fill(bar, progress({ done: payload.done ?? 0, total: payload.total ?? expected, label: 'Importing' }));
    });

    try {
      const result = await bridge.invoke('import.confirm', {
        stageId: staged.stageId,
        label,
        verify: Boolean(verify)
      });

      unsubscribe();
      staged = null;

      if (!result?.ok) {
        toast.error('The import did not run', result?.error ?? null);
        stepChoose();
        return;
      }

      const failed = result.failures?.length ?? 0;
      toast.ok(`Imported ${format.plural(result.added, 'account')}`,
        failed ? `${failed} row${failed === 1 ? '' : 's'} could not be written.` : null);

      const verified = result.verified;

      dialog.setBody(h('div', [
        h('div.callout.callout--ok', [
          icon('check-circle', { size: 15 }),
          h('div', [
            h('b', `${format.plural(result.added, 'account')} imported`),
            h('p', 'They are in the account list and ready to use.')
          ])
        ]),

        verified ? h('div.grid.grid--3', { style: { marginTop: '14px' } }, [
          h('div.stat', [h('div.stat__label', 'Working'), h('div.stat__value.stat--ok', format.num(verified.counts.ok))]),
          h('div.stat', [h('div.stat__label', 'Failed'), h('div.stat__value', format.num(verified.counts.failed))]),
          h('div.stat', [h('div.stat__label', 'Offline-mode'), h('div.stat__value', format.num(verified.counts.skipped))])
        ]) : null,

        failed ? h('div.callout.callout--warn', { style: { marginTop: '14px' } }, [
          icon('alert-triangle', { size: 15 }),
          h('div', [
            h('b', `${failed} could not be written`),
            h('div', { style: { display: 'grid', gap: '3px', marginTop: '6px' } },
              result.failures.slice(0, 8).map((failure) => h('div.mono-sm', `Line ${failure.line}: ${failure.reason}`)))
          ])
        ]) : null
      ]));
      hydrate(dialog.element);

      dialog.setFooter([
        h('div.spacer'),
        h('button.btn', {
          type: 'button',
          onclick: () => { dialog.close(); store.emit(store.TOPICS.NAVIGATE, 'accounts'); }
        }, 'Show the accounts'),
        h('button.btn.btn--primary', {
          type: 'button',
          onclick: () => { dialog.close(); openImportDialog(); }
        }, 'Import another file')
      ]);
    } catch (err) {
      unsubscribe();
      toast.fromError(err, 'The import failed');
      dialog.setFooter([
        h('div.spacer'),
        h('button.btn.btn--primary', { type: 'button', onclick: () => stepChoose() }, 'Start again')
      ]);
    }
  }

  stepChoose();
  return dialog;
}
