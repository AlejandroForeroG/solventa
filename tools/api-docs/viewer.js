const selector = document.getElementById('spec-select');
const download = document.getElementById('download-spec');
const status = document.getElementById('status');

const header = document.querySelector('.docs-header');
const syncHeaderHeight = () => document.documentElement.style.setProperty('--docs-header-height', `${header.getBoundingClientRect().height}px`);
syncHeaderHeight();
new ResizeObserver(syncHeaderHeight).observe(header);

const specId = url => url.slice('/api/docs/'.length).replace(/\.json$/, '');

async function showSpec() {
  selector.disabled = true;
  status.hidden = false;
  status.textContent = 'Loading specification…';
  download.hidden = true;
  try {
    const response = await fetch(selector.value, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error('Specification unavailable');
    const spec = await response.json();
    const pageUrl = new URL(window.location.href);
    pageUrl.searchParams.set('spec', specId(selector.value));
    window.history.replaceState(null, '', pageUrl);
    window.Scalar.createApiReference('#docs-reference', {
      content: spec,
      layout: 'modern',
      theme: 'none',
      showSidebar: true,
      darkMode: false,
      forceDarkModeState: 'light',
      hideDarkModeToggle: true,
      withDefaultFonts: false,
      hideClientButton: true,
      hideTestRequestButton: true,
      showDeveloperTools: 'never',
      documentDownloadType: 'json',
      modelsSectionLabel: 'Schemas',
      defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' },
      baseServerURL: window.location.origin,
      telemetry: false,
      persistAuth: false,
      agent: { disabled: true },
      mcp: { disabled: true },
    });
    download.href = selector.value;
    download.hidden = false;
    status.hidden = true;
  } catch {
    status.textContent = 'Could not load this specification. Reload the page to retry.';
  } finally {
    selector.disabled = false;
  }
}

try {
  const response = await fetch('/api/docs/catalog.json', { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error('Catalog unavailable');
  const catalog = await response.json();
  if (!Array.isArray(catalog) || !catalog.length) throw new Error('Empty catalog');
  document.getElementById('environment').textContent = response.headers.get('x-solventa-environment') ?? '';
  const requestedSpec = new URL(window.location.href).searchParams.get('spec');
  for (const entry of catalog) {
    if (typeof entry.name !== 'string' || !/^\/api\/docs\/v[1-9][0-9]*\/[a-z][a-z0-9-]*\.json$/.test(entry.url)) throw new Error('Invalid catalog');
    selector.add(new Option(entry.name, entry.url));
  }
  const selectedSpec = catalog.find(entry => specId(entry.url) === requestedSpec);
  if (selectedSpec) selector.value = selectedSpec.url;
  selector.addEventListener('change', () => {
    const pageUrl = new URL(window.location.href);
    pageUrl.searchParams.set('spec', specId(selector.value));
    pageUrl.hash = '';
    // A fresh document also clears Scalar's pending lazy-navigation scroll state.
    window.location.assign(pageUrl);
  });
  await showSpec();
} catch {
  selector.disabled = true;
  status.textContent = 'Could not load the API documentation. Reload the page to retry.';
}
