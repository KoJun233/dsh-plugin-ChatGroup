// Local line icons keep the plugin independent of host icon internals and CDNs.
const paths = {
  network: 'M12 8v4m-7 4v-4h14v4M9 3h6v5H9zM2 16h6v5H2zM16 16h6v5h-6z',
  card: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm3 6 2 2-2 2m5 0h4',
  plus: 'M12 5v14M5 12h14',
  radar: 'M4 12h4l2-5 4 10 2-5h4',
  search: 'M16 16l4 4M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z',
  file: 'M5 3h9l5 5v13H5zM14 3v6h5M8 13h8m-8 4h6',
  refresh: 'M20 10a8 8 0 1 0-1.8 7.2M20 5v5h-5',
  edit: 'm4 16-1 5 5-1L20 8l-4-4ZM14 6l4 4',
  remove: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
  chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-4a2 2 0 0 1-1-1.7V6a2 2 0 0 1 2-2Zm2 5h10M7 13h6',
  expand: 'm6 9 6 6 6-6',
  collapse: 'm6 15 6-6 6 6',
  check: 'm5 12 4 4 10-10',
  warn: 'M12 8v5m0 3v.1M10.3 4 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0Z',
  wait: 'M21 12a9 9 0 0 0-9-9',
}
export function settingIcon(h, name, size = 16) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false }, h('path', { d: paths[name] }))
}

export function settingAction(h, label, name, { className = '', ...props } = {}, suffix = null) {
  return h('button', { type: 'button', className: `a2a-icon-btn ${className}`.trim(), title: label, 'aria-label': label, ...props },
    settingIcon(h, name), suffix)
}
