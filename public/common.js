// StreamLab - Funciones comunes y utilidades globales

const PALETTE = [
  '#ff7a59', '#2ec4b6', '#3a86ff', '#8338ec', '#ff006e',
  '#fb5607', '#ffbe0b', '#06d6a0', '#118ab2', '#e76f51'
];

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function colorFor(nombre) {
  if (!nombre) return PALETTE[0];
  let hash = 0;
  for (let i = 0; i < nombre.length; i++) {
    hash = (hash << 5) - hash + nombre.charCodeAt(i);
    hash |= 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

function avatar(nombre) {
  const name = nombre || '?';
  const color = colorFor(name);
  const initials = esc(name.slice(0, 2).toUpperCase());
  return `<div class="avatar-mini" style="background: ${color}25; color: ${color}; border: 1px solid ${color}40;">${initials}</div>`;
}

function toast(msg, isError = false) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const item = document.createElement('div');
  item.className = 'toast' + (isError ? ' toast-error' : '');
  item.textContent = msg;
  container.appendChild(item);

  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transition = 'opacity 0.3s ease';
    setTimeout(() => {
      if (item.parentNode) {
        item.parentNode.removeChild(item);
      }
    }, 300);
  }, 3500);
}

async function api(url, opts = {}) {
  const options = { ...opts };
  options.headers = {
    'Accept': 'application/json',
    ...(options.headers || {})
  };

  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, options);
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }

  if (!res.ok) {
    const errorMsg = data && data.error ? data.error : `Error en la solicitud (${res.status})`;
    const error = new Error(errorMsg);
    error.status = res.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function renderTopbar(active = '') {
  const topbar = document.getElementById('topbar') || document.querySelector('.topbar');
  if (!topbar) return;

  let me = null;
  try {
    const res = await api('/api/me');
    me = res.user;
  } catch (err) {
    me = null;
  }

  let userNav = '';
  if (me) {
    userNav = `
      <a href="/c/${esc(me.username)}" class="nav-link ${active === 'my-channel' ? 'active' : ''}">Mi canal</a>
      <a href="/dashboard.html" class="btn btn-secondary ${active === 'dashboard' ? 'active' : ''}" style="padding: 0.35rem 0.75rem; font-size: 0.85rem;">Panel</a>
      <div class="user-badge">
        ${avatar(me.username)}
        <span>${esc(me.username)}</span>
      </div>
      <button id="logout-btn" class="btn btn-secondary" style="padding: 0.35rem 0.75rem; font-size: 0.85rem;">Salir</button>
    `;
  } else {
    userNav = `
      <a href="/login.html" class="btn btn-primary" style="padding: 0.35rem 0.85rem; font-size: 0.85rem;">Iniciar sesión</a>
      <a href="/login.html#register" class="btn btn-secondary" style="padding: 0.35rem 0.85rem; font-size: 0.85rem;">Registrarse</a>
    `;
  }

  topbar.innerHTML = `
    <div style="display: flex; align-items: center; gap: 1.5rem;">
      <a href="/" class="logo">
        <span class="logo-badge">SL</span>
        <span>StreamLab</span>
      </a>
      <nav class="topbar-nav">
        <a href="/" class="nav-link ${active === 'explore' ? 'active' : ''}">Explorar</a>
        <a href="/?filter=following" class="nav-link ${active === 'following' ? 'active' : ''}">Siguiendo</a>
      </nav>
    </div>
    <div class="user-menu">
      ${userNav}
    </div>
  `;

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        await api('/api/logout', { method: 'POST' });
        window.location.href = '/';
      } catch (e) {
        toast('Error al cerrar sesión', true);
      }
    });
  }
}

async function renderSidebar(el) {
  const container = typeof el === 'string' ? document.querySelector(el) : el;
  if (!container) return;

  try {
    const channels = await api('/api/channels');
    if (!channels || !channels.length) {
      container.innerHTML = `
        <div class="sidebar-title">Canales</div>
        <div style="padding: 0.5rem 1rem; color: var(--text-muted); font-size: 0.8rem;">No hay canales disponibles</div>
      `;
      return;
    }

    const liveChannels = channels.filter(c => c.is_live);
    const offlineChannels = channels.filter(c => !c.is_live);

    let html = '';
    if (liveChannels.length > 0) {
      html += `<div class="sidebar-title">Canales en vivo</div>`;
      html += '<div class="channel-list">';
      for (const ch of liveChannels) {
        html += `
          <a href="/c/${esc(ch.username)}" class="channel-item" title="${esc(ch.title || ch.username)}">
            <div class="channel-info-side">
              ${avatar(ch.username)}
              <div>
                <div class="channel-name-side">${esc(ch.username)}</div>
                <div class="channel-meta-side">${esc(ch.category || 'General')}</div>
              </div>
            </div>
            <div class="live-indicator">
              <span class="dot-live"></span>
              <span>${ch.viewers || 0}</span>
            </div>
          </a>
        `;
      }
      html += '</div>';
    }

    if (offlineChannels.length > 0) {
      html += `<div class="sidebar-title" style="margin-top: 0.5rem;">Canales recomendados</div>`;
      html += '<div class="channel-list">';
      for (const ch of offlineChannels.slice(0, 10)) {
        html += `
          <a href="/c/${esc(ch.username)}" class="channel-item" title="${esc(ch.username)}">
            <div class="channel-info-side">
              ${avatar(ch.username)}
              <div>
                <div class="channel-name-side">${esc(ch.username)}</div>
                <div class="channel-meta-side">${esc(ch.category || 'Offline')}</div>
              </div>
            </div>
            <span class="dot-offline"></span>
          </a>
        `;
      }
      html += '</div>';
    }

    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div style="padding: 1rem; color: var(--text-muted); font-size: 0.8rem;">Error al cargar canales</div>`;
  }
}

function cardHTML(canal) {
  const isLive = Boolean(canal.is_live);
  const badge = isLive
    ? `<span class="badge-live">EN VIVO</span>`
    : `<span class="badge-offline">OFFLINE</span>`;
  const viewersBadge = isLive
    ? `<span class="badge-viewers">${canal.viewers || 0} espectadores</span>`
    : '';
  const thumbContent = canal.thumb
    ? `<img src="${esc(canal.thumb)}?t=${Date.now()}" alt="${esc(canal.username)}" class="thumbnail-img" onerror="this.outerHTML='<div class=\\'thumbnail-placeholder\\'>${esc(canal.username.slice(0, 2).toUpperCase())}</div>'">`
    : `<div class="thumbnail-placeholder">${esc(canal.username.slice(0, 2).toUpperCase())}</div>`;

  return `
    <a href="/c/${esc(canal.username)}" class="stream-card">
      <div class="thumbnail-wrapper">
        ${thumbContent}
        ${badge}
        ${viewersBadge}
      </div>
      <div class="card-details">
        ${avatar(canal.username)}
        <div class="card-info">
          <div class="card-title" title="${esc(canal.title || 'Sin título')}">${esc(canal.title || 'Directo sin título')}</div>
          <div class="card-author">${esc(canal.username)}</div>
          <div class="card-category">${esc(canal.category || 'General')}</div>
        </div>
      </div>
    </a>
  `;
}
