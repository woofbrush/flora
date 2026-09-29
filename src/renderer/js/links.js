/**
 * flora's own addresses.
 *
 * One definition, read by the renderer and by the main process's application
 * menu. It lives in the renderer tree because the renderer is the side that
 * cannot reach out of its own origin - the flora:// protocol serves
 * `src/renderer` and refuses anything above it - so a module the renderer can
 * import has to sit here, and the main process, which has no such limit,
 * imports it from here.
 *
 * The point of the file is that the invite appears in five places: the About
 * dialog, the command palette, the title bar, the Help menu and the addons
 * pane. A link copied into five files is a link that is wrong in four of them
 * the first time it changes.
 */
export const LINKS = {
  website: 'https://woofbrush.com',
  // A permanent invite. If Discord ever expires it, this is the one line that
  // has to change.
  discord: 'https://discord.gg/zbAH77TECp'
};
