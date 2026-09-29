/**
 * Changing a skin, for one account or for all of them.
 *
 * Three ways in, because they are three genuinely different intentions: upload
 * a PNG, copy a skin that is already in flora onto other accounts, or go back to
 * the default. All three run through the same bulk endpoint on the backend, so
 * the progress, the throttling and the error handling are the same code.
 *
 * The preview is drawn locally from the cached skin (see lib/heads.js) - flora
 * never asks a third-party avatar service what an account looks like.
 */
import { h, fill, debounce } from '../dom.js';
import { icon, hydrate } from '../icons.js';
import * as bridge from '../bridge.js';
import * as store from '../store.js';
import * as format from '../format.js';
import * as toast from '../components/toast.js';
import { modal, confirm as confirmDialog } from '../components/overlay.js';
import { progress } from '../components/table.js';
import { bodyElement, headElement, loadSkin } from '../lib/heads.js';
import { field, searchField } from './shell.js';
import { reload, selectAll } from '../actions.js';

const MODELS = [
  { id: 'classic', label: 'Classic', note: 'The wide-armed model. Almost every skin is this.' },
  { id: 'slim', label: 'Slim', note: 'The 3-pixel-arm model, sometimes called Alex.' }
];

const MODEL_LABEL = Object.fromEntries(MODELS.map((m) => [m.id, m.label]));

/**
 * Open the skin picker.
 *
 * Called with an explicit list from a row menu or a bulk button, and with
 * nothing from the command palette, where the selection is the obvious subject.
 */
export function openSkinPicker(ids = null) {
  const targets = [...new Set((ids ?? store.selectedIds()).map(Number).filter(Number.isFinite))];

  const title = targets.length === 1
    ? (store.accountById(targets[0])?.username || 'Account')
    : `${format.num(targets.length)} accounts`;

  const dialog = modal({
    title: targets.length === 1 ? `Skin for ${title}` : `Skin for ${title}`,
    subtitle: 'Uploaded straight to Mojang with each account\'s own token.',
    size: 'wide',
    actions: [{ label: 'Close' }]
  });

  if (!targets.length) {
    paintEmpty();
    return dialog;
  }

  /** Which account the preview shows. The first one with a cached skin, else the first. */
  let previewId = (targets.find((id) => store.accountById(id)?.skinHash) ?? targets[0]);
  let model = store.accountById(previewId)?.skinModel ?? 'classic';
  let busy = false;
  let unsubscribe = null;

  // ------------------------------------------------------------ chrome

  const previewHost = h('div');
  const headsHost = h('div.row', { style: { gap: '4px', flexWrap: 'wrap' } });
  const actionHost = h('div', { style: { display: 'grid', gap: '6px' } });
  const busyHost = h('div');

  const body = h('div', {
    style: { display: 'grid', gridTemplateColumns: '210px minmax(0, 1fr)', gap: '22px', alignItems: 'start' }
  });

  const left = h('div', { style: { position: 'sticky', top: '0' } }, [previewHost, headsHost]);
  const right = h('div', { style: { minWidth: '0' } }, [actionHost, busyHost]);

  body.append(left, right);
  dialog.setBody(body);

  // ------------------------------------------------------------ preview

  function paintPreview() {
    const account = store.accountById(previewId);
    const count = targets.length;

    fill(previewHost, h('div', {
      style: {
        display: 'grid',
        justifyItems: 'center',
        gap: '10px',
        padding: '16px 12px',
        background: 'var(--crust)',
        border: '1px solid var(--surface1)',
        borderRadius: 'var(--r-md)'
      }
    }, [
      bodyElement(account?.skinHash ?? null, { height: 200 }),
      h('div', { style: { textAlign: 'center', width: '100%' } }, [
        h('b', { style: { display: 'block', fontSize: 'var(--fs-sm)' } },
          account?.username || 'Unnamed'),
        h('span.muted', { style: { fontSize: 'var(--fs-xs)' } },
          account?.skinHash
            ? `${MODEL_LABEL[account.skinModel] ?? account.skinModel ?? 'Classic'} · cached`
            : 'No skin on record')
      ])
    ]));
    hydrate(previewHost);

    // A strip of every account that will be changed, so "all of them" is
    // something the user can see rather than a number they have to trust.
    fill(headsHost, targets.slice(0, 24).map((id) => {
      const row = store.accountById(id);
      const head = headElement(row?.skinHash ?? null, { name: row?.username ?? null, size: 24 });
      head.style.outline = id === previewId ? '2px solid var(--accent)' : 'none';
      head.style.outlineOffset = '1px';
      head.style.borderRadius = 'var(--r-xs)';
      head.style.cursor = 'pointer';
      head.title = row?.username || `Account ${id}`;
      head.addEventListener('click', () => {
        previewId = id;
        model = row?.skinModel ?? model;
        paintPreview();
        paintActions();
      });
      return head;
    }));

    if (targets.length > 24) {
      headsHost.appendChild(h('span.muted', {
        style: { fontSize: 'var(--fs-xs)', alignSelf: 'center' }
      }, `+${format.num(targets.length - 24)} more`));
    }
  }

  // ------------------------------------------------------------ actions

  function paintActions() {
    const account = store.accountById(previewId);

    fill(actionHost, [
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } }, [
        h('button.btn.btn--primary', {
          type: 'button',
          disabled: busy,
          onclick: () => upload()
        }, [icon('folder-download', { size: 15 }), 'Upload a PNG…']),
        h('button.btn', {
          type: 'button',
          disabled: busy,
          onclick: () => stepCopyFrom()
        }, [icon('copy-01', { size: 15 }), 'Copy from an account'])
      ]),

      h('div', { style: { marginTop: '14px' } }, [
        h('div.section-title', 'Model'),
        h('div.row', { style: { gap: '6px' } }, MODELS.map((entry) => h('button.chip', {
          type: 'button',
          'aria-pressed': model === entry.id ? 'true' : 'false',
          disabled: busy,
          onclick: () => { model = entry.id; paintActions(); }
        }, [
          icon('onboarding-account', { size: 13 }),
          entry.label
        ]))),
        h('p.muted', { style: { fontSize: 'var(--fs-xs)', marginTop: '6px' } },
          MODELS.find((m) => m.id === model)?.note ?? '')
      ]),

      h('hr.divider'),

      h('div.section-title', 'Other things to do'),
      h('div', { style: { display: 'grid', gap: '6px' } }, [
        actionRow('download-cloud-02', 'Fetch the current skins first',
          'Downloads each account\'s skin from Mojang so the previews are accurate.', () => fetchFirst()),
        actionRow('download-01', `Save ${account?.username || 'this'}'s skin as a file`,
          'Writes the cached PNG somewhere you choose.', () => saveCurrentSkin(),
          { disabled: !account?.skinHash }),
        actionRow('refresh-ccw-02', 'Reset to the default skin',
          'Takes the skin off every selected account, leaving the plain Steve or Alex.',
          () => resetAll(), { danger: true })
      ])
    ]);
    hydrate(actionHost);
  }

  function actionRow(iconName, label, note, run, { disabled = false, danger = false } = {}) {
    return h('button.menu__item', {
      type: 'button',
      disabled: busy || disabled,
      style: { height: 'auto', padding: '10px' },
      onclick: run
    }, [
      icon(iconName, { size: 18 }),
      h('span.grow', [
        h('b', { style: { display: 'block', fontWeight: '500', color: danger ? 'var(--red)' : null } }, label),
        h('span.muted', { style: { display: 'block', fontSize: 'var(--fs-xs)' } }, note)
      ])
    ]);
  }

  // ------------------------------------------------------------ running

  /**
   * Show progress for whatever bulk job is in flight.
   *
   * Two events feed this: `app:busy` opens and closes the bar, and
   * `skins:progress` carries the running count.
   */
  function watchProgress() {
    unsubscribe?.();
    unsubscribe = store.subscribe(store.TOPICS.BUSY, (payload) => {
      if (payload?.scope && payload.scope !== 'apply-skin') return;
      if (payload?.event && payload.event !== 'skins:progress') return;

      if (payload.scope && !payload.active) { fill(busyHost, null); return; }
      if (payload.event) {
        fill(busyHost, progress({
          done: payload.done ?? 0,
          total: payload.total ?? targets.length,
          label: 'Uploading'
        }));
      }
    });
  }

  function setBusy(value) {
    busy = value;
    paintActions();
  }

  async function upload() {
    let file;
    try {
      file = await bridge.ui.openSkinFile();
    } catch (err) {
      toast.fromError(err, 'Could not open that file');
      return;
    }
    if (file?.cancelled || !file?.pngBase64) return;

    await run(() => bridge.invoke('skins.applyMany', {
      ids: targets,
      pngBase64: file.pngBase64,
      model
    }), 'apply');
  }

  async function fetchFirst() {
    try {
      const result = await bridge.invoke('skins.fetchMany', { ids: targets, force: false });
      const { fetched, cached, none, failed } = result.counts;
      const parts = [];
      if (fetched) parts.push(`${fetched} downloaded`);
      if (cached) parts.push(`${cached} already cached`);
      if (none) parts.push(`${none} with no skin`);
      if (failed) parts.push(`${failed} failed`);
      (failed ? toast.warn : toast.ok)('Skins refreshed', parts.join(' · '));
      paintPreview();
    } catch (err) {
      toast.fromError(err, 'Could not fetch those skins');
    }
  }

  async function saveCurrentSkin() {
    const account = store.accountById(previewId);
    try {
      const base64 = await skinBase64(account?.skinHash);
      if (!base64) {
        toast.warn('No skin to save', 'That account has no cached skin yet.');
        return;
      }
      const saved = await bridge.ui.saveImage({
        base64,
        defaultName: `${(account?.username || 'flora').replace(/[^\w.-]/g, '_')}-skin.png`
      });
      if (saved?.cancelled) return;
      toast.ok('Skin saved', saved?.path ? format.truncateMiddle(saved.path, 24, 16) : null);
    } catch (err) {
      toast.fromError(err, 'Could not save that skin');
    }
  }

  async function resetAll() {
    const confirmed = await confirmDialog({
      title: targets.length === 1 ? 'Reset this skin?' : `Reset ${format.num(targets.length)} skins?`,
      message: 'Each account will be put back on the default skin.',
      detail: 'The current skins are not kept anywhere - this cannot be undone.',
      confirmLabel: 'Reset',
      danger: true
    });
    if (!confirmed) return;

    await run(() => bridge.invoke('skins.resetMany', { ids: targets }), 'reset');
  }

  /** `what` decides which counter in the result is worth reporting. */
  async function run(call, what) {
    watchProgress();
    setBusy(true);
    const handle = toast.info(
      what === 'reset' ? 'Resetting skins…' : 'Applying the skin…',
      `Working through ${format.plural(targets.length, 'account')}.`,
      { id: 'skins-apply', timeout: 0 }
    );

    try {
      const result = await call();
      handle.close();
      fill(busyHost, null);

      const { applied = 0, reset = 0, failed = 0 } = result?.counts ?? {};
      const ok = what === 'reset' ? reset : applied;

      if (failed) {
        const first = result.results?.find((r) => !r.ok)?.error;
        (ok ? toast.warn : toast.error)(
          `${format.plural(ok, 'account')} updated, ${format.num(failed)} failed`,
          first ?? null
        );
      } else {
        toast.ok(what === 'reset'
          ? `Reset ${format.plural(ok, 'skin')}`
          : `Applied the skin to ${format.plural(ok, 'account')}`);
      }

      await reload();
      paintPreview();
      if (what === 'reset') model = 'classic';
    } catch (err) {
      handle.close();
      fill(busyHost, null);
      toast.fromError(err, what === 'reset' ? 'Could not reset those skins' : 'Could not apply that skin');
    } finally {
      unsubscribe?.();
      unsubscribe = null;
      setBusy(false);
    }
  }

  // ------------------------------------------------------------ copy from

  function stepCopyFrom() {
    let query = '';
    const listHost = h('div', { style: { display: 'grid', gap: '2px', maxHeight: '320px', overflowY: 'auto' } });

    const searchBox = searchField({
      placeholder: 'Search accounts…',
      label: 'Search for the account to copy from',
      onInput: debounce((value) => {
        query = value.trim().toLowerCase();
        paintList();
      }, 140)
    });

    // Only accounts with a skin on record can be a source: copying a skin that
    // does not exist would fail one account at a time, with no useful message.
    const sources = () => store.accounts()
      .filter((a) => a.skinHash)
      .filter((a) => !query || `${a.username ?? ''} ${a.label ?? ''}`.toLowerCase().includes(query))
      .slice(0, 80);

    function paintList() {
      const rows = sources();
      if (!rows.length) {
        fill(listHost, h('p.muted', { style: { fontSize: 'var(--fs-sm)', padding: '12px 0' } },
          store.accounts().some((a) => a.skinHash)
            ? 'No account matches that search.'
            : 'No account has a cached skin yet. Fetch skins first, then copy one across.'));
        return;
      }

      fill(listHost, rows.map((account) => h('button.menu__item', {
        type: 'button',
        style: { height: 'auto', padding: '8px 10px' },
        onclick: () => applyFrom(account)
      }, [
        headElement(account.skinHash, { name: account.username, size: 24 }),
        h('span.grow', [
          h('b', { style: { display: 'block', fontWeight: '500' } }, account.username || `Account ${account.id}`),
          h('span.muted', { style: { fontSize: 'var(--fs-xs)' } },
            `${MODEL_LABEL[account.skinModel] ?? 'Classic'}${account.label ? ` · ${account.label}` : ''}`)
        ]),
        icon('chevron-right', { size: 18 })
      ])));
      hydrate(listHost);
    }

    fill(body, h('div', [
      h('div.callout.callout--info', [
        icon('info-circle', { size: 15 }),
        h('div', [
          h('b', 'Copying reuses the cached image'),
          h('p', 'The skin is uploaded to each account from flora\'s own copy, so this costs one download no matter how many accounts there are.')
        ])
      ]),
      h('div', { style: { marginTop: '14px' } }, [
        field({ label: 'Copy the skin from', control: searchBox.el }).el,
        listHost
      ])
    ]));
    hydrate(body);

    dialog.setFooter([
      h('button.btn.btn--ghost', { type: 'button', onclick: () => restore() }, [
        icon('arrow-left', { size: 14 }), 'Back'
      ]),
      h('div.spacer'),
      h('span.muted', { style: { fontSize: 'var(--fs-sm)' } },
        `Onto ${format.plural(targets.length, 'account')}.`)
    ]);

    paintList();
  }

  async function applyFrom(source) {
    const targetsWithoutSource = targets.filter((id) => id !== source.id);
    if (!targetsWithoutSource.length) {
      toast.info('That is the only account selected', 'Nothing to copy onto.');
      return;
    }

    restore();
    await run(() => bridge.invoke('skins.copyFrom', {
      sourceId: source.id,
      ids: targetsWithoutSource,
      model: null
    }), 'apply');
  }

  /** Put the picker back after a sub-step, footer and all. */
  function restore() {
    dialog.setBody(body);
    dialog.setFooter([
      h('div.grow.muted', { style: { fontSize: 'var(--fs-sm)' } },
        `${format.plural(targets.length, 'account')} will be changed.`),
      h('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Close')
    ]);
    paintPreview();
    paintActions();
  }

  // ------------------------------------------------------------ empty

  function paintEmpty() {
    fill(dialog.element.querySelector('.modal__body'), h('div', [
      h('div.callout.callout--idle', [
        icon('paint-pour', { size: 15 }),
        h('div', [
          h('b', 'No accounts selected'),
          h('p', 'Tick the accounts you want to change in the account list, or open the skin picker from a row\'s own menu.')
        ])
      ]),
      h('div.row', { style: { marginTop: '14px', gap: '8px' } }, [
        h('button.btn.btn--outline', {
          type: 'button',
          onclick: async () => {
            await selectAll();
            dialog.close();
            openSkinPicker(store.selectedIds());
          }
        }, [icon('check-circle', { size: 15 }), 'Select every account']),
        h('button.btn', {
          type: 'button',
          onclick: () => { dialog.close(); store.emit(store.TOPICS.NAVIGATE, 'accounts'); }
        }, 'Go to the account list')
      ])
    ]));
    hydrate(dialog.element);
  }

  // ------------------------------------------------------------ start

  dialog.setFooter([
    h('div.grow.muted', { style: { fontSize: 'var(--fs-sm)' } },
      `${format.plural(targets.length, 'account')} will be changed.`),
    h('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Close')
  ]);

  paintPreview();
  paintActions();

  const originalClose = dialog.close;
  return {
    ...dialog,
    close: () => { unsubscribe?.(); originalClose(); }
  };
}

/**
 * The cached skin as base64 PNG.
 *
 * Read through the same `flora://app/skin/<hash>.png` URL the previews use and
 * re-encoded here, which keeps the backend free of a "hand me the bytes" call
 * that would exist for this one button.
 */
function skinBase64(hash) {
  return loadSkin(hash).then((image) => {
    if (!image) return null;
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1] ?? null;
  }).catch(() => null);
}
