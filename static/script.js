// Mumbai Delivery Optimizer - script.js
// All geocoding goes through Flask proxy (/search, /reverse, /geocode)

// --- Map init ---
const map = L.map('map', { zoomControl: false }).setView([19.0760, 72.8777], 12);
L.control.zoom({ position: 'bottomright' }).addTo(map);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '(c) OpenStreetMap (c) CARTO',
  subdomains: 'abcd', maxZoom: 19
}).addTo(map);

// --- State ---
let trafficLayers = [];
let markers       = [];
let stopCounter   = 0;
let lastRoute     = null;
let lastOrdered   = [];

const OSRM_APIS = [
  'https://router.project-osrm.org/route/v1/driving',
  'https://routing.openstreetmap.de/routed-car/route/v1/driving'
];

const TRAFFIC_CFG = {
  green:  { color: '#22c55e', label: 'Low',    weight: 5, opacity: 0.95 },
  orange: { color: '#f59e0b', label: 'Medium', weight: 5, opacity: 0.95 },
  red:    { color: '#ef4444', label: 'Heavy',  weight: 6, opacity: 0.95 },
};
const PEAK_MULT = { green: 1.12, orange: 1.55, red: 2.0 };

function classifyStep(step, idx, trafficOn) {
  const distM   = step.distance || 0;
  const durS    = step.duration || 1;
  const freeKmh = (distM / durS) * 3.6;
  const isHighway  = freeKmh > 65;
  const isMainRoad = freeKmh > 35 && freeKmh <= 65;
  const coords = step.geometry && step.geometry.coordinates;
  const cx     = coords && coords[0] ? Math.round(coords[0][0] * 10000) : 0;
  const seed   = (idx * 1103515245 + cx * 22695477 + 12345) & 0x7fffffff;
  const r      = seed / 0x7fffffff;
  if (!trafficOn) {
    if (isHighway)  return r < 0.80 ? 'green' : 'orange';
    if (isMainRoad) return r < 0.55 ? 'green' : (r < 0.85 ? 'orange' : 'red');
                    return r < 0.25 ? 'green' : (r < 0.65 ? 'orange' : 'red');
  } else {
    if (isHighway)  return r < 0.30 ? 'green' : (r < 0.65 ? 'orange' : 'red');
    if (isMainRoad) return r < 0.10 ? 'green' : (r < 0.45 ? 'orange' : 'red');
                    return r < 0.04 ? 'green' : (r < 0.22 ? 'orange' : 'red');
  }
}

function setCurrentLocation() {
  if (!navigator.geolocation) { showError('Geolocation not supported.'); return; }
  showLoading('Getting your location...');
  navigator.geolocation.getCurrentPosition(
    async pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      const input = document.getElementById('start');
      try {
        const res  = await fetch('/reverse?lat=' + lat + '&lon=' + lng);
        const data = await res.json();
        input.value         = (data.display_name || '').split(',').slice(0, 4).join(', ');
        input.dataset.label = input.value;
      } catch {
        input.value         = lat.toFixed(6) + ',' + lng.toFixed(6);
        input.dataset.label = 'My Location';
      }
      input.dataset.lat = lat;
      input.dataset.lng = lng;
      addMapMarker([lat, lng], 'My Location (Start)', true);
      map.setView([lat, lng], 14);
      hideStatus();
    },
    err => {
      const msgs = { 1: 'Permission denied.', 2: 'Unavailable.', 3: 'Timed out.' };
      showError((msgs[err.code] || 'Could not get location.') + ' Please type your address.');
    }
  );
}

function addStop() {
  stopCounter++;
  const inputId = 'stop-' + stopCounter;
  const suggId  = 'sugg-stop-' + stopCounter;
  const rowId   = 'row-stop-' + stopCounter;

  const row = document.createElement('div');
  row.className = 'stop-row';
  row.id = rowId;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:1; position:relative;';

  const icon = document.createElement('span');
  icon.className = 'input-icon';
  icon.textContent = '📦';

  const input = document.createElement('input');
  input.id = inputId;
  input.className = 'field';
  input.placeholder = 'Building name, road, area...';
  input.autocomplete = 'off';

  const suggBox = document.createElement('div');
  suggBox.className = 'suggestions-box';
  suggBox.id = suggId;

  wrap.appendChild(icon);
  wrap.appendChild(input);
  wrap.appendChild(suggBox);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-btn';
  removeBtn.title = 'Remove';
  removeBtn.innerHTML = '&#x2715;';
  removeBtn.onclick = function() { removeStop(rowId); };

  row.appendChild(wrap);
  row.appendChild(removeBtn);
  document.getElementById('stops').appendChild(row);
  attachAutocomplete(input, suggId);
}

function removeStop(rowId) {
  var el = document.getElementById(rowId);
  if (el) el.remove();
}

function attachAutocomplete(input, suggBoxId) {
  var timer = null;
  input.addEventListener('input', function() {
    clearTimeout(timer);
    timer = setTimeout(function() { doFetch(input, suggBoxId); }, 380);
  });
  input.addEventListener('blur', function() {
    setTimeout(function() {
      const box = document.getElementById(suggBoxId);
      if (box && !box.matches(':hover')) hideSuggBox(suggBoxId);
    }, 220);
  });
  input.addEventListener('focus', function() {
    const box = document.getElementById(suggBoxId);
    if (box && box.children.length > 0) showSuggBox(suggBoxId);
  });
}

function attachStartAutocomplete() {
  attachAutocomplete(document.getElementById('start'), 'start-sugg');
}

async function doFetch(input, suggBoxId) {
  const query = input.value.trim();
  const box   = document.getElementById(suggBoxId);
  if (!box) return;
  if (query.length < 3 || /^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(query)) {
    hideSuggBox(suggBoxId); return;
  }
  box.innerHTML = '<div class="sugg-item" style="color:var(--muted);font-size:12px;">🔍 Searching...</div>';
  showSuggBox(suggBoxId);
  try {
    const res  = await fetch('/search?q=' + encodeURIComponent(query));
    if (!res.ok) throw new Error('Server error ' + res.status);
    const data = await res.json();
    box.innerHTML = '';
    if (!data || !data.length || data.error) {
      box.innerHTML = '<div class="sugg-item" style="color:var(--muted);font-size:12px;">No results found in Mumbai</div>';
      showSuggBox(suggBoxId);
      return;
    }
    data.sort(function(a, b) { return addrPrec(b) - addrPrec(a); });
    data.forEach(function(place) {
      const label    = buildLabel(place);
      const mainName = (place.namedetails && place.namedetails.name) || place.display_name.split(',')[0];
      const subAddr  = place.display_name.split(',').slice(1, 4).join(',').trim();
      const item = document.createElement('div');
      item.className = 'sugg-item';
      const mainDiv = document.createElement('div');
      mainDiv.className = 'sugg-main';
      mainDiv.textContent = mainName;
      const subDiv = document.createElement('div');
      subDiv.className = 'sugg-sub';
      subDiv.textContent = subAddr;
      item.appendChild(mainDiv);
      item.appendChild(subDiv);
      item.title = place.display_name;
      item.addEventListener('mousedown', function(e) {
        e.preventDefault();
        input.value         = label;
        input.dataset.lat   = place.lat;
        input.dataset.lng   = place.lon;
        input.dataset.label = label;
        hideSuggBox(suggBoxId);
        input.style.borderColor = 'var(--success)';
        setTimeout(function() { input.style.borderColor = ''; }, 1500);
      });
      box.appendChild(item);
    });
    showSuggBox(suggBoxId);
  } catch (err) {
    console.warn('Autocomplete error:', err);
    box.innerHTML = '<div class="sugg-item" style="color:var(--danger);font-size:12px;">⚠ ' + err.message + '</div>';
    showSuggBox(suggBoxId);
  }
}

function addrPrec(place) {
  const addr = place.address || {};
  if (addr.house_number) return 5;
  if (place.type === 'house' || place.type === 'building') return 4;
  if (place.class === 'amenity' || place.class === 'shop') return 3;
  if (place.type === 'road' || place.type === 'street') return 2;
  return 1;
}

function buildLabel(place) {
  const addr  = place.address || {};
  const parts = [];
  const name  = (place.namedetails && place.namedetails.name)
             || addr.amenity || addr.building || addr.shop || addr.tourism || addr.leisure;
  if (name) parts.push(name);
  if (addr.house_number && addr.road) parts.push(addr.house_number + ' ' + addr.road);
  else if (addr.road) parts.push(addr.road);
  if (addr.suburb || addr.neighbourhood) parts.push(addr.suburb || addr.neighbourhood);
  if (addr.city_district) parts.push(addr.city_district);
  if (!parts.length) return place.display_name.split(',').slice(0, 4).join(', ');
  return parts.join(', ');
}

function showSuggBox(id) {
  const b = document.getElementById(id);
  if (b && b.children.length) b.style.display = 'block';
}
function hideSuggBox(id) {
  const b = document.getElementById(id);
  if (b) b.style.display = 'none';
}

document.addEventListener('mousedown', function(e) {
  if (!e.target.closest('.input-wrap') && !e.target.closest('.suggestions-box')) {
    document.querySelectorAll('.suggestions-box').forEach(function(b) { b.style.display = 'none'; });
  }
});

async function getCoordinates(input) {
  const raw = typeof input === 'string' ? input.trim() : input.value.trim();
  if (!raw) return null;
  if (input.dataset && input.dataset.lat && input.dataset.lng)
    return [parseFloat(input.dataset.lat), parseFloat(input.dataset.lng)];
  if (/^-?\d+\.?\d*,\s*-?\d+\.?\d*$/.test(raw))
    return raw.split(',').map(Number);
  try {
    const res  = await fetch('/geocode?q=' + encodeURIComponent(raw));
    const data = await res.json();
    if (!data || !data.length) {
      showError('Could not find: "' + raw.substring(0, 45) + '". Please select from the dropdown.');
      return null;
    }
    return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
  } catch {
    showError('Network error. Check your connection.');
    return null;
  }
}

function clearMarkers() {
  markers.forEach(function(m) { map.removeLayer(m); });
  markers = [];
}

function addMapMarker(latlng, label, isStart) {
  const color = isStart ? '#22d3a5' : '#f97316';
  const size  = isStart ? 18 : 14;
  const icon  = L.divIcon({
    html: '<div style="width:' + size + 'px;height:' + size + 'px;background:' + color
        + ';border-radius:50%;border:2.5px solid #fff;'
        + 'box-shadow:0 0 0 3px ' + color + '44,0 2px 10px rgba(0,0,0,.5);"></div>',
    className: '', iconSize: [size, size], iconAnchor: [size/2, size/2]
  });
  const m = L.marker(latlng, { icon }).addTo(map).bindPopup('<b>' + label + '</b>', { maxWidth: 240 });
  markers.push(m);
  return m;
}

function clearTrafficLayers() {
  trafficLayers.forEach(function(l) { map.removeLayer(l); });
  trafficLayers = [];
}

async function fetchOSRMRoute(waypoints, apiBase) {
  const coordStr = waypoints.map(function(c) { return c.lng + ',' + c.lat; }).join(';');
  const url = apiBase + '/' + coordStr + '?steps=true&geometries=geojson&overview=full&annotations=false';
  const res  = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error('OSRM HTTP ' + res.status);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('OSRM code: ' + data.code);
  return data;
}

function drawTrafficSegments(osrmRoute, trafficOn) {
  clearTrafficLayers();
  const counts = { green: 0, orange: 0, red: 0 };
  let totalAdjSecs = 0, segCount = 0, globalStepIdx = 0;
  osrmRoute.legs.forEach(function(leg) {
    leg.steps.forEach(function(step) {
      globalStepIdx++;
      if (!step.distance || step.distance < 5) return;
      if (!step.geometry || !step.geometry.coordinates || step.geometry.coordinates.length < 2) return;
      const level = classifyStep(step, globalStepIdx, trafficOn);
      const cfg   = TRAFFIC_CFG[level];
      counts[level]++;
      totalAdjSecs += (step.duration || 0) * (trafficOn ? PEAK_MULT[level] : 1);
      const coords = step.geometry.coordinates.map(function(c) { return [c[1], c[0]]; });
      const poly = L.polyline(coords, { color: cfg.color, weight: cfg.weight, opacity: cfg.opacity, lineCap: 'round', lineJoin: 'round' }).addTo(map);
      const speedKmh = Math.round((step.distance / (step.duration || 1)) * 3.6);
      poly.bindTooltip('<b>' + cfg.label + ' traffic</b><br>~' + speedKmh + ' km/h', { sticky: true, className: 'traffic-tooltip', direction: 'top' });
      trafficLayers.push(poly);
      segCount++;
    });
  });
  if (segCount === 0 && osrmRoute.geometry && osrmRoute.geometry.coordinates.length > 1) {
    const coords = osrmRoute.geometry.coordinates.map(function(c) { return [c[1], c[0]]; });
    const poly   = L.polyline(coords, { color: '#f59e0b', weight: 5, opacity: 0.9, lineCap: 'round' }).addTo(map);
    trafficLayers.push(poly);
    const totalSec = osrmRoute.legs.reduce(function(s, l) { return s + l.duration; }, 0);
    totalAdjSecs = totalSec * (trafficOn ? PEAK_MULT.orange : 1);
    counts.orange = 1;
  }
  return { counts: counts, adjustedSecs: totalAdjSecs };
}

function onTrafficChange() {
  const cb  = document.getElementById('trafficToggle');
  const row = document.getElementById('trafficToggleRow');
  row.classList.toggle('active', cb.checked);
  if (lastRoute) {
    const result = drawTrafficSegments(lastRoute, cb.checked);
    updateMetrics(lastRoute, result, cb.checked);
  }
}

function updateMetrics(osrmRoute, trafficResult, trafficOn) {
  const distM   = osrmRoute.legs.reduce(function(s, l) { return s + l.distance; }, 0);
  const baseSec = osrmRoute.legs.reduce(function(s, l) { return s + l.duration; }, 0);
  const adjSec  = trafficResult.adjustedSecs;
  document.getElementById('dist').textContent     = (distM / 1000).toFixed(1) + ' km';
  document.getElementById('baseTime').textContent = Math.round(baseSec / 60) + ' min';
  document.getElementById('adjTime').textContent  = Math.round(adjSec  / 60) + ' min';
  document.getElementById('distCard').classList.add('has-value');
  document.getElementById('timeCard').classList.add('has-value');
  const c = trafficResult.counts;
  const total = (c.green + c.orange + c.red) || 1;
  const pG = Math.round(c.green  / total * 100);
  const pO = Math.round(c.orange / total * 100);
  const pR = Math.round(c.red    / total * 100);
  document.getElementById('bar-green').style.width  = pG + '%';
  document.getElementById('bar-orange').style.width = pO + '%';
  document.getElementById('bar-red').style.width    = pR + '%';
  document.getElementById('pct-green').textContent  = pG + '%';
  document.getElementById('pct-orange').textContent = pO + '%';
  document.getElementById('pct-red').textContent    = pR + '%';
  document.getElementById('trafficBreakdown').style.display = 'block';
  const delayMins = Math.round((adjSec - baseSec) / 60);
  const badge = document.getElementById('delayBadge');
  if (trafficOn && delayMins > 0) {
    badge.textContent   = '+' + delayMins + ' min delay';
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

function clientOptimize(points) {
  if (points.length <= 2) return points.map(function(p, i) { return { coord: p, origIdx: i }; });
  function hav(a, b) {
    var R=6371, dL=(b[0]-a[0])*Math.PI/180, dN=(b[1]-a[1])*Math.PI/180;
    var h=Math.sin(dL/2)*Math.sin(dL/2)+Math.cos(a[0]*Math.PI/180)*Math.cos(b[0]*Math.PI/180)*Math.sin(dN/2)*Math.sin(dN/2);
    return R*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
  }
  var start = points[0];
  var unvisited = points.slice(1).map(function(p, i) { return { coord: p, origIdx: i+1 }; });
  var result = [{ coord: start, origIdx: 0 }];
  while (unvisited.length) {
    var last = result[result.length-1].coord;
    var best=0, bestD=Infinity;
    unvisited.forEach(function(u, i) { var d = hav(last, u.coord); if (d < bestD) { bestD = d; best = i; } });
    result.push(unvisited[best]);
    unvisited.splice(best, 1);
  }
  return result;
}

async function optimize() {
  const startInput = document.getElementById('start');
  const startVal   = startInput.value.trim();
  const stopRows   = Array.from(document.querySelectorAll('#stops .field')).filter(function(i) { return i.value.trim(); });
  if (!startVal)        { showError('Please enter or detect a start location.'); return; }
  if (!stopRows.length) { showError('Add at least one delivery stop.'); return; }
  const btn = document.getElementById('optimizeBtn');
  btn.disabled = true;
  showLoading('Geocoding locations...');
  try {
    const startCoord = await getCoordinates(startInput);
    if (!startCoord) { btn.disabled = false; return; }
    const startLabel = startInput.dataset.label || startVal.split(',')[0].substring(0, 45);
    const stops = [];
    for (var i = 0; i < stopRows.length; i++) {
      const inp = stopRows[i];
      const c   = await getCoordinates(inp);
      if (!c) { btn.disabled = false; return; }
      stops.push({ coord: c, label: inp.dataset.label || inp.value.split(',')[0].substring(0, 45) });
    }
    const allPoints = [{ coord: startCoord, label: startLabel }].concat(stops);
    showLoading('Optimizing route order...');
    let ordered;
    try {
      const res = await fetch('/optimize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coords: allPoints.map(function(p) { return p.coord; }) })
      });
      if (!res.ok) throw new Error('server');
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      ordered = result.route.map(function(rCoord) {
        var match = allPoints.find(function(p) {
          return Math.abs(p.coord[0]-rCoord[0]) < 0.0001 && Math.abs(p.coord[1]-rCoord[1]) < 0.0001;
        });
        return match || { coord: rCoord, label: 'Stop' };
      });
    } catch {
      var raw = clientOptimize(allPoints.map(function(p) { return p.coord; }));
      ordered  = raw.map(function(r) { return allPoints[r.origIdx]; });
    }
    lastOrdered = ordered;
    clearMarkers();
    clearTrafficLayers();
    lastRoute = null;
    ordered.forEach(function(loc, i) {
      addMapMarker(loc.coord, i === 0 ? ('Start: ' + loc.label) : ('Stop ' + i + ': ' + loc.label), i === 0);
    });
    showLoading('Fetching road route...');
    const waypoints = ordered.map(function(loc) { return { lat: loc.coord[0], lng: loc.coord[1] }; });
    let osrmData = null;
    for (var ai = 0; ai < OSRM_APIS.length; ai++) {
      try {
        showLoading('Routing... (server ' + (ai+1) + ' of ' + OSRM_APIS.length + ')');
        osrmData = await fetchOSRMRoute(waypoints, OSRM_APIS[ai]);
        break;
      } catch (err) {
        console.warn(OSRM_APIS[ai] + ' failed:', err.message);
      }
    }
    if (!osrmData) {
      showError('All routing servers failed. Check your connection.');
      btn.disabled = false;
      return;
    }
    const osrmRoute = osrmData.routes[0];
    lastRoute       = osrmRoute;
    const trafficOn = document.getElementById('trafficToggle').checked;
    const result    = drawTrafficSegments(osrmRoute, trafficOn);
    updateMetrics(osrmRoute, result, trafficOn);
    renderRouteList(ordered);
    const bounds = L.latLngBounds(ordered.map(function(loc) { return L.latLng(loc.coord[0], loc.coord[1]); }));
    map.fitBounds(bounds, { padding: [60, 60] });
    hideStatus();
    btn.disabled = false;
  } catch (err) {
    console.error('optimize() error:', err);
    showError('Unexpected error: ' + err.message);
    btn.disabled = false;
  }
}

function renderRouteList(ordered) {
  const list = document.getElementById('routeList');
  list.innerHTML = '';
  ordered.forEach(function(loc, i) {
    const item = document.createElement('div');
    item.className = 'route-item';
    item.style.animationDelay = (i * 55) + 'ms';
    item.innerHTML =
      '<div class="' + (i === 0 ? 'route-dot start' : 'route-dot') + '">' + (i === 0 ? '&#9658;' : i) + '</div>' +
      '<div class="route-name" title="' + loc.label + '">' + loc.label + '</div>';
    list.appendChild(item);
  });
  document.getElementById('routeOrderSection').style.display = 'block';
}

function showLoading(msg) {
  const s = document.getElementById('statusBar');
  s.className = 'status-bar loading';
  s.innerHTML = '<div class="spinner"></div><span>' + msg + '</span>';
}
function showError(msg) {
  const s = document.getElementById('statusBar');
  s.className = 'status-bar error';
  s.textContent = '⚠ ' + msg;
}
function hideStatus() {
  const s = document.getElementById('statusBar');
  s.className = 'status-bar';
  s.innerHTML = '';
}

attachStartAutocomplete();
addStop();