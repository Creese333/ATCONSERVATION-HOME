/* atmap.js: the map engine for the A.T. Resource Grid, on MapLibre GL JS 5.24.0 (UMD build, loaded before this file).

   What is here
   - G: small geometry helpers (points, lat/lng, bounds) with the methods app.js uses.
   - ATMap: the map. It wraps a maplibregl.Map and answers in the dashboard's own terms.
   - The basemap tile queue (protocol "atq://"), the basemaps, and the drawing order of layers.

   ZOOM NUMBERS. Everything in app.js counts zoom the Leaflet way: one more than MapLibre's number at the same scale
   (Leaflet's world is 256 px wide at zoom 0, MapLibre's is 512). ATMap converts at the edge, so a threshold in app.js
   such as "hex cells from zoom 10.5" means what it always meant. Only code in this file sees MapLibre's numbers.

   COORDINATE ORDER. app.js keeps [lat, lng] (the grid file is written that way). MapLibre wants [lng, lat]. Convert with
   G.ll() and Bounds.toLngLat(); never hand an app.js array straight to MapLibre.

   LAYERS are added on 'style.load' (ATMap.ready), never on 'load': 'load' waits for every first tile and never fires
   when a basemap service is down. */
(function(){
'use strict';
const ml = window.maplibregl;
const ZO = 1;   /* app.js zoom = MapLibre zoom + ZO */

/* ---------- geometry ---------- */
class Pt { constructor(x, y){ this.x = x; this.y = y; }
  add(p){ p = G.pt(p); return new Pt(this.x + p.x, this.y + p.y); } subtract(p){ p = G.pt(p); return new Pt(this.x - p.x, this.y - p.y); }
  divideBy(k){ return new Pt(this.x / k, this.y / k); } multiplyBy(k){ return new Pt(this.x * k, this.y * k); }
  distanceTo(p){ p = G.pt(p); return Math.hypot(this.x - p.x, this.y - p.y); } round(){ return new Pt(Math.round(this.x), Math.round(this.y)); } }
class LL { constructor(lat, lng){ this.lat = lat; this.lng = lng; } toArray(){ return [this.lat, this.lng]; } toLngLat(){ return [this.lng, this.lat]; } }
class Bounds {
  constructor(a, b){ this.s = Infinity; this.w = Infinity; this.n = -Infinity; this.e = -Infinity;
    if (a == null) return; if (b != null){ this.extend(a); this.extend(b); return; }
    if (a instanceof Bounds){ this.extend(a); return; }
    if (Array.isArray(a) && a.length && (Array.isArray(a[0]) || typeof a[0] === 'object')) a.forEach(p => this.extend(p)); else this.extend(a); }
  extend(p){ if (p instanceof Bounds){ if (!p.isValid()) return this; this.s = Math.min(this.s, p.s); this.w = Math.min(this.w, p.w); this.n = Math.max(this.n, p.n); this.e = Math.max(this.e, p.e); return this; }
    const q = G.ll(p); if (!q || !isFinite(q.lat) || !isFinite(q.lng)) return this;
    this.s = Math.min(this.s, q.lat); this.n = Math.max(this.n, q.lat); this.w = Math.min(this.w, q.lng); this.e = Math.max(this.e, q.lng); return this; }
  isValid(){ return isFinite(this.s) && isFinite(this.w) && isFinite(this.n) && isFinite(this.e); }
  pad(r){ const dy = (this.n - this.s) * r, dx = (this.e - this.w) * r, o = new Bounds(); o.s = this.s - dy; o.n = this.n + dy; o.w = this.w - dx; o.e = this.e + dx; return o; }
  contains(p){ if (p instanceof Bounds) return p.s >= this.s && p.n <= this.n && p.w >= this.w && p.e <= this.e;
    const q = G.ll(p); return !!q && q.lat >= this.s && q.lat <= this.n && q.lng >= this.w && q.lng <= this.e; }
  intersects(b){ return b.s <= this.n && b.n >= this.s && b.w <= this.e && b.e >= this.w; }
  getCenter(){ return new LL((this.s + this.n) / 2, (this.w + this.e) / 2); }
  getSouth(){ return this.s; } getNorth(){ return this.n; } getWest(){ return this.w; } getEast(){ return this.e; }
  getSouthWest(){ return new LL(this.s, this.w); } getNorthEast(){ return new LL(this.n, this.e); }
  getNorthWest(){ return new LL(this.n, this.w); } getSouthEast(){ return new LL(this.s, this.e); }
  toBBoxString(){ return [this.w, this.s, this.e, this.n].join(','); }
  toLngLat(){ return [[this.w, this.s], [this.e, this.n]]; } }
const G = {
  Pt, LL, Bounds,
  pt(x, y){ if (x instanceof Pt) return x; if (Array.isArray(x)) return new Pt(x[0], x[1]); if (x && typeof x === 'object') return new Pt(x.x, x.y); return new Pt(x, y); },
  /* a lat/lng from [lat, lng], {lat, lng}, {lat, lon}, a MapLibre LngLat, or (lat, lng) */
  ll(a, b){ if (a instanceof LL) return a; if (typeof a === 'number') return new LL(a, b); if (Array.isArray(a)) return new LL(a[0], a[1]);
    if (a && typeof a === 'object') return new LL(a.lat, a.lng != null ? a.lng : a.lon); return null; },
  bounds(a, b){ return new Bounds(a, b); },
  /* [lat, lng] ring to a GeoJSON [lng, lat] ring, closed */
  ring(r){ const o = r.map(p => [p[1], p[0]]); if (o.length && (o[0][0] !== o[o.length - 1][0] || o[0][1] !== o[o.length - 1][1])) o.push(o[0]); return o; },
  /* the replacement for L.DomEvent.disableClickPropagation / disableScrollPropagation on a panel drawn over the map */
  stopClicks(el){ ['click', 'dblclick', 'mousedown', 'pointerdown', 'touchstart', 'contextmenu'].forEach(t => el.addEventListener(t, e => e.stopPropagation(), {passive:true})); return el; },
  stopScroll(el){ el.addEventListener('wheel', e => e.stopPropagation(), {passive:true}); return el; },
  /* metres between two points (the same sphere Leaflet used) */
  distance(a, b){ a = G.ll(a); b = G.ll(b); const R = 6371000, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))); },
  /* Leaflet's pixel coordinates at an app.js zoom: the world is 256 * 2^z pixels wide */
  project(ll, z){ ll = G.ll(ll); const s = 256 * 2 ** z, la = Math.max(-85.0511, Math.min(85.0511, ll.lat)) * Math.PI / 180;
    return new Pt((ll.lng + 180) / 360 * s, (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * s); },
  unproject(p, z){ p = G.pt(p); const s = 256 * 2 ** z, n = Math.PI - 2 * Math.PI * p.y / s;
    return new LL(180 / Math.PI * Math.atan(Math.sinh(n)), p.x / s * 360 - 180); }
};

/* ---------- basemap tile queue ----------
   Basemap tiles come from map services that drop requests when too many arrive at once. Every basemap tile URL is written
   atq://host/path#source/z/x/y and fetched here instead of by MapLibre: each tile waits its turn (a few at a time per
   service), a tile that fails is asked for again a little later each time, and NAIP Plus falls back to plain NAIP.
   MapLibre only hears about a tile once it has arrived or every try has failed. A tile that still failed is noted and
   asked for again with map.refreshTiles a while later (and when the connection comes back), so holes close themselves.
   Tiles MapLibre no longer needs (the map moved on) are cancelled through the abort signal and give up their slot. */
const TILEMAX = {'basemap.nationalmap.gov':10, 'imagery.nationalmap.gov':4}, TILETRY = 4, TILEWAIT = 25000;
/* services that are slow and are asked only once the map stops moving (the sharp imagery the image service draws on request) */
const IDLEHOST = {'imagery.nationalmap.gov':1};
const Q = {};
const queue = host => Q[host] || (Q[host] = {n:0, wait:[], max:TILEMAX[host] || 8});
function pump(q){ while (q.n < q.max && q.wait.length){ const w = q.wait.shift(); if (w.dead) continue; q.n++; w.go(); } }
function slot(host, signal){ const q = queue(host);
  return new Promise((ok, no) => { const w = {go:ok}; q.wait.push(w);
    if (signal) signal.addEventListener('abort', () => { w.dead = true; no(new DOMException('aborted', 'AbortError')); }, {once:true}); pump(q); }); }
function free(host){ const q = queue(host); if (q.n > 0) q.n--; pump(q); }
const sleep = (ms, signal) => new Promise((ok, no) => { const t = setTimeout(ok, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); no(new DOMException('aborted', 'AbortError')); }, {once:true}); });
let moving = false, still = [];
const whenStill = signal => moving ? new Promise((ok, no) => { still.push(ok); if (signal) signal.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError')), {once:true}); }) : Promise.resolve();
const NAIPPLUS = '/USGSNAIPPlus/', NAIPPLAIN = '/USGSNAIPImagery/';
/* a tile that never came, by source: retried later with refreshTiles */
const MISSED = new Map(), MISSN = new Map();
let offline = false;   /* set by ATMap.offline(): no signal, so nothing is asked of the network */
async function tileLoad(params, ac){
  const raw = params.url.slice('atq://'.length), hash = raw.indexOf('#'), url = 'https://' + (hash < 0 ? raw : raw.slice(0, hash)), tag = hash < 0 ? '' : raw.slice(hash + 1);
  const host = new URL(url).hostname, sig = ac.signal;
  let last;
  for (let n = 0; n < TILETRY; n++){
    if (n) await sleep(500 * n * (.7 + Math.random() * .6), sig);
    if (IDLEHOST[host]) await whenStill(sig);
    await slot(host, sig);
    const u = n && url.includes(NAIPPLUS) ? url.replace(NAIPPLUS, NAIPPLAIN) : url;   /* a picture NAIP Plus could not draw is asked of plain NAIP */
    const ctl = new AbortController(), stop = () => ctl.abort(), t = setTimeout(stop, TILEWAIT);
    sig.addEventListener('abort', stop, {once:true});
    try {
      const r = await fetch(n ? u + (u.includes('?') ? '&' : '?') + 'again=' + n : u, {signal:ctl.signal, mode:'cors', credentials:'omit'});
      if (r.status === 404 || r.status === 400){ last = new Error('HTTP ' + r.status); break; }   /* the service has no such tile: asking again will not change that */
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ct = r.headers.get('content-type') || '';
      if (ct && !/^image\//.test(ct)) throw new Error('not an image');   /* the image services answer some errors with a 200 and a JSON message */
      const data = await r.arrayBuffer();
      if (tag){ const [src, k] = splitTag(tag), m = MISSN.get(src); if (m) m.delete(k); }
      return {data, cacheControl:r.headers.get('cache-control'), expires:r.headers.get('expires')};
    } catch (e){ if (sig.aborted) throw e; last = e; }
    finally { clearTimeout(t); sig.removeEventListener('abort', stop); free(host); }
  }
  if (tag && !offline && !(last && /HTTP 40[04]/.test(last.message))){ const [src, k] = splitTag(tag);
    const tries = MISSN.get(src) || new Map(); MISSN.set(src, tries); const c = (tries.get(k) || 0) + 1; tries.set(k, c);
    if (c <= 3){ if (!MISSED.has(src)) MISSED.set(src, new Set()); MISSED.get(src).add(k); } }
  throw last || new Error('tile failed');
}
const splitTag = t => { const i = t.indexOf('/'); return [t.slice(0, i), t.slice(i + 1)]; };
ml.addProtocol('atq', tileLoad);
const atq = (url, src) => url.replace(/^https:\/\//, 'atq://') + '#' + src + '/{z}/{x}/{y}';

/* ---------- basemaps ----------
   Each basemap is one or two raster layers; switching basemaps changes which are visible. */
const TNM = 'https://basemap.nationalmap.gov/arcgis/rest/services/';
const OSMA = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const ATTR = 'Basemap: USGS The National Map';
const NAIPX = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage';
const NAIPPX = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage';
const NAIPPA = 'Imagery: USGS NAIP Plus (NAIP and high resolution orthoimagery) via <a href="https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer" target="_blank" rel="noopener">USGS The National Map</a>';
const NAIPA = 'Imagery: USDA NAIP via <a href="https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer" target="_blank" rel="noopener">USGS The National Map</a>';
const DPR = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
const tnm = (svc, max) => ({tiles:[TNM + svc + '/MapServer/tile/{z}/{y}/{x}'], maxzoom:max || 16});
/* the sharp picture the USGS image service draws for each 512 px tile, from zoom naipFrom in */
const sharp = (svc, interp, q) => ({tiles:[svc + '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=' + Math.round(512 * DPR) + ',' + Math.round(512 * DPR) +
  '&format=jpg&compressionQuality=' + q + '&interpolation=' + interp + '&f=image'], tileSize:512, maxzoom:17});
/* [key, name, dark?, layers]: each layer is [source spec, attribution, {minzoom (app.js zoom), paint}] */
const UNDER = {spec:tnm('USGSImageryOnly'), id:'imgunder'}, UNDER14 = {spec:tnm('USGSImageryOnly', 14), id:'imgunder14'};
/* an imagery basemap: the cached USGS imagery tiles underneath (zoom 14 and stretched when there is no signal: those are the
   tiles Save for offline keeps), and the sharp picture on top from naipFrom in */
const imgParts = (sh, attr, from) => [[UNDER, attr, {online:1}], [UNDER14, attr, {offline:1}], [sh, attr, {minzoom:from, sharp:1}]];
const BASEDEF = [
  ['osm', 'OpenStreetMap', 0, [[{tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom:19}, OSMA]]],
  ['hires', 'USGS imagery, highest resolution', 1, imgParts(sharp(NAIPPX, 'RSP_CubicConvolution', 94), NAIPPA, 15)],
  ['naip', 'NAIP aerial (USDA)', 1, imgParts(sharp(NAIPX, 'RSP_BilinearInterpolation', 92), NAIPA, 16)],
  ['img', 'USGS imagery', 1, imgParts(sharp(NAIPX, 'RSP_BilinearInterpolation', 92), ATTR, 17)],
  ['relief', 'USGS shaded relief', 0, [[tnm('USGSShadedReliefOnly'), ATTR]]],
  ['otm', 'OpenTopoMap', 0, [[{tiles:['a', 'b', 'c'].map(s => 'https://' + s + '.tile.opentopomap.org/{z}/{x}/{y}.png'), maxzoom:17},
    'Map data: ' + OSMA + ', SRTM. Style: &copy; <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA)']]]
];

/* ---------- 3D terrain ----------
   Elevation from the AWS Terrain Tiles (Terrarium encoding, to zoom 14; the same source viewshed.html uses), through the tile
   queue like the basemaps. Off until the 3D button is pressed; the hillshade under the cells shows only in 3D. */
const DEM = {type:'raster-dem', encoding:'terrarium', tileSize:256, maxzoom:14, attribution:'Terrain: AWS Terrain Tiles',
  tiles:[atq('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', 'dem')]};
const EXAG = 1.4, PITCH3D = 60;

/* ---------- drawing order ----------
   Empty marker layers split the style into slots, bottom to top. map.addLayer(spec, slot) puts a layer at the top of its slot. */
const SLOTS = ['base', 'cells', 'lands', 'states', 'corr', 'trail', 'phdots', 'segs', 'sel', 'feat', 'top'];

/* ---------- the map ---------- */
class ATMap {
  /* o: {minZoom, maxZoom, base} with zooms in app.js terms */
  constructor(el, o){
    o = o || {};
    this._el = typeof el === 'string' ? document.getElementById(el) : el;
    this._h = new Map(); this._ready = []; this._isReady = false;
    this.BASEDEF = BASEDEF; this.base = null; this._offline = false;
    const sources = {empty:{type:'geojson', data:{type:'FeatureCollection', features:[]}}}, layers = [];
    const seen = {};
    BASEDEF.forEach(([key, , , parts]) => parts.forEach((p, i) => {
      const spec = p[0], o2 = p[2] || {}, sid = spec.id || ('b-' + key + '-' + i);
      if (!seen[sid]){ seen[sid] = 1; const s = spec.spec || spec;
        sources[sid] = {type:'raster', tiles:s.tiles.map(t => atq(t, sid)), tileSize:s.tileSize || 256, maxzoom:s.maxzoom, attribution:p[1]}; }
      layers.push({id:'b-' + key + '-' + i, type:'raster', source:sid, layout:{visibility:'none'}, minzoom:o2.minzoom ? o2.minzoom - ZO : 0,
        paint:Object.assign({'raster-fade-duration':o2.sharp ? 350 : 200}, o2.paint || {})}); }));
    sources.dem = DEM; sources.demhs = Object.assign({}, DEM, {tiles:[DEM.tiles[0].replace('#dem/', '#demhs/')]});   /* MapLibre draws better with separate sources for terrain and hillshade */
    layers.push({id:'hillshade', type:'hillshade', source:'demhs', layout:{visibility:'none'}, paint:{'hillshade-exaggeration':.25, 'hillshade-shadow-color':'#2B3A2E', 'hillshade-highlight-color':'#FFFFFF'}});
    SLOTS.forEach(s => layers.push({id:'slot:' + s, type:'fill', source:'empty', paint:{'fill-opacity':0}}));
    this.ml = new ml.Map({container:this._el, style:{version:8, sources, layers},
      minZoom:(o.minZoom != null ? o.minZoom : 4) - ZO, maxZoom:(o.maxZoom != null ? o.maxZoom : 18) - ZO,
      center:[-77.5, 39.5], zoom:5 - ZO, maxPitch:70, attributionControl:false, dragRotate:false, pitchWithRotate:true, touchPitch:false,   /* pitchWithRotate: in 3D (dragRotate on) right-drag up and down tilts */
      boxZoom:false, maxTileCacheSize:600, fadeDuration:0});
    this.ml.touchZoomRotate.disableRotation(); this.ml.keyboard.disableRotation();
    this.attribution = new ml.AttributionControl({compact:false});
    this.ml.addControl(this.attribution, 'bottom-right');
    this.zoomControl = new ml.NavigationControl({showCompass:false});
    this.ml.addControl(this.zoomControl, 'top-left');
    { const z = this._el.querySelector('.maplibregl-ctrl-zoom-in'); if (z) z.parentNode.classList.add('zoomctl'); }   /* the page lays its control rows out beside it */
    this._3d = false;
    this.ml.on('style.load', () => { try { this.ml.setSky({'sky-color':'#9DB8D3', 'horizon-color':'#DCE6EE', 'fog-color':'#DCE6EE', 'sky-horizon-blend':.6, 'horizon-fog-blend':.5, 'fog-ground-blend':.6}); } catch (e){}
      this._isReady = true; if (o.base) this.setBase(o.base); this._ready.splice(0).forEach(f => f()); });
    /* the sharp imagery waits until the map stops */
    this.ml.on('movestart', () => { moving = true; });
    this.ml.on('moveend', () => { moving = false; still.splice(0).forEach(f => f()); });
    /* tiles that never came are asked for again a while later, and when the connection comes back */
    const retry = () => { if (this._offline) return; MISSED.forEach((set, src) => { if (!set.size || !this.ml.getSource(src)) return;
      const ids = [...set].map(k => { const [z, x, y] = k.split('/').map(Number); return {z, x, y}; }); set.clear();
      try { this.ml.refreshTiles(src, ids); } catch (e){} }); };
    setInterval(retry, 30000); addEventListener('online', retry);
    this.dragging = {enable:() => this.ml.dragPan.enable(), disable:() => this.ml.dragPan.disable(), enabled:() => this.ml.dragPan.isEnabled()};
    this.options = {crs:null};
  }
  /* run f once the style is in (now, if it already is) */
  ready(f){ if (this._isReady) f(); else this._ready.push(f); return this; }
  getContainer(){ return this._el; }
  /* ---- basemaps ---- */
  setBase(key){ const b = BASEDEF.find(x => x[0] === key); if (!b) return; this.base = key; if (!this._isReady) return;
    BASEDEF.forEach(([k, , , parts]) => parts.forEach((p, i) => {
      const f = p[2] || {}, id = 'b-' + k + '-' + i, on = k === key && (this._offline ? !f.sharp && !f.online : !f.offline);
      if (this.ml.getLayer(id)) this.ml.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); })); }
  /* with no signal, imagery stops asking for the sharp pictures and stretches the saved trail-level tiles (zoom 14) instead */
  offline(off){ this._offline = offline = !!off; if (off && this._3d) this.set3D(false, {animate:false}); if (this.base) this.setBase(this.base); this.ml.fire('view3d', {on:this._3d}); }
  /* ---- 3D: terrain under everything, the map tilted; rotating and tilting allowed only in 3D. The flat map is north up, as before. ---- */
  is3D(){ return this._3d; }
  set3D(on, o){ on = !!on && !this._offline; if (on === this._3d) return this; this._3d = on; const m = this.ml, quick = o && o.animate === false;
    if (on){ m.setTerrain({source:'dem', exaggeration:EXAG}); this.show('hillshade', true);
      m.dragRotate.enable(); m.touchZoomRotate.enableRotation(); m.touchPitch.enable(); m.keyboard.enableRotation();
      m.easeTo({pitch:PITCH3D, duration:quick ? 0 : 900}); }
    else { m.dragRotate.disable(); m.touchZoomRotate.disableRotation(); m.touchPitch.disable(); m.keyboard.disableRotation();
      const flat = () => { m.setTerrain(null); this.show('hillshade', false); };
      if (quick){ m.jumpTo({pitch:0, bearing:0}); flat(); } else { m.easeTo({pitch:0, bearing:0, duration:700}); m.once('moveend', () => { if (!this._3d) flat(); }); } }
    m.fire('view3d', {on}); return this; }
  north(){ this.ml.easeTo({bearing:0, duration:500}); return this; }
  /* ---- layers ---- */
  addLayer(spec, slot){ if (this.ml.getLayer(spec.id)) return; this.ml.addLayer(spec, 'slot:' + (slot || 'top')); }
  removeLayer(id){ if (this.ml.getLayer(id)) this.ml.removeLayer(id); }
  hasLayer(id){ return !!this.ml.getLayer(id); }
  show(id, on){ if (this.ml.getLayer(id)) this.ml.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); }
  addSource(id, spec){ if (!this.ml.getSource(id)) this.ml.addSource(id, spec); return this.ml.getSource(id); }
  /* ---- view ---- */
  getZoom(){ return this.ml.getZoom() + ZO; }
  getMinZoom(){ return this.ml.getMinZoom() + ZO; } getMaxZoom(){ return this.ml.getMaxZoom() + ZO; }
  getCenter(){ const c = this.ml.getCenter(); return new LL(c.lat, c.lng); }
  getBounds(){ const b = this.ml.getBounds(); return new Bounds([b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]); }
  getSize(){ return new Pt(this._el.clientWidth, this._el.clientHeight); }
  _cam(o, d){ const r = {}; if (o && o.animate === false) r.duration = 0; else if (o && o.duration != null) r.duration = o.duration * 1000; else if (d != null) r.duration = d; return r; }
  setView(ll, z, o){ ll = G.ll(ll); const c = {center:[ll.lng, ll.lat], zoom:(z != null ? z : this.getZoom()) - ZO};
    if (o && o.animate) this.ml.easeTo(Object.assign(c, this._cam(o, 300))); else this.ml.jumpTo(c); return this; }
  setZoom(z, o){ return this.setView(this.getCenter(), z, o); }
  flyTo(ll, z, o){ ll = G.ll(ll); this.ml.flyTo(Object.assign({center:[ll.lng, ll.lat], zoom:(z != null ? z : this.getZoom()) - ZO, essential:true}, this._cam(o))); return this; }
  _pad(o){ o = o || {}; const p = o.padding ? G.pt(o.padding) : new Pt(0, 0), tl = o.paddingTopLeft ? G.pt(o.paddingTopLeft) : p, br = o.paddingBottomRight ? G.pt(o.paddingBottomRight) : p;
    return {top:tl.y, left:tl.x, bottom:br.y, right:br.x}; }
  _fit(b, o){ const B = b instanceof Bounds ? b : new Bounds(b); if (!B.isValid()) return null;
    const r = {padding:this._pad(o)}; if (o && o.maxZoom != null) r.maxZoom = o.maxZoom - ZO; return [B, r]; }
  fitBounds(b, o){ const f = this._fit(b, o); if (!f) return this; const [B, r] = f;
    /* a box narrower than the padding cannot be fitted; centre on it instead */
    try { this.ml.fitBounds(B.toLngLat(), Object.assign(r, this._cam(o, o && o.animate ? 500 : 0))); } catch (e){ this.setView(B.getCenter(), this.getZoom()); } return this; }
  flyToBounds(b, o){ const f = this._fit(b, o); if (!f) return this; const [B, r] = f;
    try { this.ml.fitBounds(B.toLngLat(), Object.assign(r, {linear:false, essential:true}, this._cam(o, 1200))); } catch (e){} return this; }
  getBoundsZoom(b, inside, padding){ const B = b instanceof Bounds ? b : new Bounds(b);
    const c = this.ml.cameraForBounds(B.toLngLat(), {padding:this._pad({padding})}); return c ? c.zoom + ZO : this.getZoom(); }
  panBy(p, o){ p = G.pt(p); this.ml.panBy([p.x, p.y], this._cam(o, 250)); return this; }
  stop(){ this.ml.stop(); return this; }
  invalidateSize(){ this.ml.resize(); return this; }
  /* Leaflet pixel space at an app.js zoom (the current one when z is left out) */
  project(ll, z){ return G.project(ll, z != null ? z : this.getZoom()); }
  unproject(p, z){ return G.unproject(p, z != null ? z : this.getZoom()); }
  latLngToContainerPoint(ll){ ll = G.ll(ll); const p = this.ml.project([ll.lng, ll.lat]); return new Pt(p.x, p.y); }
  latLngToLayerPoint(ll){ return this.latLngToContainerPoint(ll); }
  containerPointToLatLng(p){ p = G.pt(p); const q = this.ml.unproject([p.x, p.y]); return new LL(q.lat, q.lng); }
  distance(a, b){ return G.distance(a, b); }
  /* ---- events: Leaflet names, several at once separated by spaces; 'click' and friends carry latlng ---- */
  _wrap(t, f){ const self = this; return function(e){ const o = Object.assign({}, e || {}); o.type = t; o.originalEvent = e && e.originalEvent;
    if (e && e.lngLat){ o.latlng = new LL(e.lngLat.lat, e.lngLat.lng); o.containerPoint = new Pt(e.point.x, e.point.y); }
    return f.call(self, o); }; }
  on(types, f){ types.split(/\s+/).filter(Boolean).forEach(t => { if (t.startsWith('location')){ this._locH(t).push(f); return; }
    const w = this._wrap(t, f); if (!this._h.has(f)) this._h.set(f, []); this._h.get(f).push([t, w]); this.ml.on(t, w); }); return this; }
  once(types, f){ const ts = types.split(/\s+/).filter(Boolean); let done = false;
    const g = e => { if (done) return; done = true; this.off(types, g); f.call(this, e); }; this.on(ts.join(' '), g); return this; }
  off(types, f){ const ts = types.split(/\s+/).filter(Boolean), hs = this._h.get(f) || [];
    hs.filter(h => ts.includes(h[0])).forEach(h => this.ml.off(h[0], h[1])); this._h.set(f, hs.filter(h => !ts.includes(h[0])));
    ts.filter(t => t.startsWith('location')).forEach(t => { const a = this._locH(t), i = a.indexOf(f); if (i >= 0) a.splice(i, 1); }); return this; }
  /* ---- your location (navigator.geolocation), with Leaflet's events: locationfound {latlng, accuracy}, locationerror {code, message} ---- */
  _locH(t){ this._lh = this._lh || {}; return this._lh[t] || (this._lh[t] = []); }
  locate(o){ this.stopLocate(); o = o || {}; const fire = (t, e) => this._locH(t).slice().forEach(f => f.call(this, e));
    const ok = p => fire('locationfound', {latlng:new LL(p.coords.latitude, p.coords.longitude), accuracy:p.coords.accuracy, timestamp:p.timestamp});
    const no = e => fire('locationerror', {code:e.code, message:e.message});
    const opt = {enableHighAccuracy:!!o.enableHighAccuracy, maximumAge:o.maximumAge || 0, timeout:o.timeout || 10000};
    if (o.watch) this._watch = navigator.geolocation.watchPosition(ok, no, opt); else navigator.geolocation.getCurrentPosition(ok, no, opt); return this; }
  stopLocate(){ if (this._watch != null && navigator.geolocation){ navigator.geolocation.clearWatch(this._watch); this._watch = null; } return this; }
}

/* ---------- overlays: one GeoJSON source and its layers, drawn in one slot ----------
   new Overlay(map, 'sel', 'sel', [{type:'line', paint:{...}}, ...]); .set(geojson or null); .show(on); .paint(i, prop, value) */
const EMPTY = () => ({type:'FeatureCollection', features:[]});
class Overlay {
  constructor(map, id, slot, layers){ this.map = map; this.id = id; this.ids = layers.map((l, i) => id + '-' + i); this.on = true;
    map.addSource(id, {type:'geojson', data:EMPTY(), tolerance:.2});
    layers.forEach((l, i) => map.addLayer(Object.assign({id:this.ids[i], source:id}, l), slot)); }
  set(g){ const s = this.map.ml.getSource(this.id); if (s) s.setData(g || EMPTY()); this.data = g; return this; }
  clear(){ return this.set(null); }
  show(on){ this.on = !!on; this.ids.forEach(i => this.map.show(i, this.on)); return this; }
  paint(i, prop, v){ if (this.map.hasLayer(this.ids[i])) this.map.ml.setPaintProperty(this.ids[i], prop, v); return this; } }
/* [lat, lng] rings (one ring, or a list of them) as a GeoJSON polygon outline */
G.polys = rings => { if (!rings || !rings.length) return null; const list = Array.isArray(rings[0][0]) ? rings : [rings];
  return {type:'FeatureCollection', features:list.filter(r => r && r.length).map(r => ({type:'Feature', properties:{}, geometry:{type:'Polygon', coordinates:[G.ring(Array.isArray(r[0][0]) ? r[0] : r)]}}))}; };
/* [lat, lng] lines (a list of them) as one GeoJSON MultiLineString */
G.lines = lines => ({type:'FeatureCollection', features:lines && lines.length ? [{type:'Feature', properties:{}, geometry:{type:'MultiLineString', coordinates:lines.map(l => l.map(p => [p[1], p[0]]))}}] : []});
/* every position of a GeoJSON geometry, as [lat, lng] */
G.coords = g => { const out = [], walk = a => { if (typeof a[0] === 'number') out.push([a[1], a[0]]); else a.forEach(walk); }; if (g && g.coordinates) walk(g.coordinates); return out; };
G.Overlay = Overlay; G.empty = EMPTY;

/* a circle as a GeoJSON polygon (for the accuracy ring around your location) */
G.circle = (ll, m, n) => { ll = G.ll(ll); n = n || 64; const out = [], dLa = m / 111320, dLo = m / (111320 * Math.cos(ll.lat * Math.PI / 180));
  for (let i = 0; i <= n; i++){ const a = i / n * 2 * Math.PI; out.push([ll.lng + dLo * Math.cos(a), ll.lat + dLa * Math.sin(a)]); }
  return {type:'Feature', properties:{}, geometry:{type:'Polygon', coordinates:[out]}}; };

ATMap.BASEDEF = BASEDEF;
/* for checking from the console: tiles waiting to be asked for again, by source */
ATMap.missed = () => [...MISSED].map(([s, set]) => [s, set.size]).filter(x => x[1]);
window.G = G; window.ATMap = ATMap;
})();
