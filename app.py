from flask import Flask, render_template, request, jsonify
import math
import urllib.request
import urllib.parse
import json

app = Flask(__name__)

NOMINATIM_HEADERS = {
    'User-Agent': 'MumbaiDeliveryOptimizer/1.0 (local dev)',
    'Accept-Language': 'en'
}
MUMBAI_VIEWBOX = '72.75,18.85,73.05,19.35'

# ── Haversine distance (km) ────────────────────────────────────────
def haversine(a, b):
    R = 6371
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return R * 2 * math.asin(math.sqrt(h))

# ── Nearest-Neighbor TSP heuristic ────────────────────────────────
def optimize_route(points):
    if len(points) <= 2:
        return points
    start     = points[0]
    unvisited = list(points[1:])
    route     = [start]
    while unvisited:
        last        = route[-1]
        nearest_idx = min(range(len(unvisited)),
                          key=lambda i: haversine(last, unvisited[i]))
        route.append(unvisited.pop(nearest_idx))
    return route

def nominatim_get(url):
    req = urllib.request.Request(url, headers=NOMINATIM_HEADERS)
    with urllib.request.urlopen(req, timeout=8) as resp:
        return json.loads(resp.read().decode('utf-8'))

@app.route('/')
def index():
    return render_template('index.html')

# ── Proxy: autocomplete search ─────────────────────────────────────
@app.route('/search')
def search():
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify([])
    if 'mumbai' not in q.lower() and 'maharashtra' not in q.lower():
        q = q + ', Mumbai'
    url = (
        'https://nominatim.openstreetmap.org/search'
        '?format=json&limit=7&addressdetails=1&namedetails=1'
        '&viewbox=' + MUMBAI_VIEWBOX + '&bounded=1'
        '&q=' + urllib.parse.quote(q)
    )
    try:
        data = nominatim_get(url)
        return jsonify(data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ── Proxy: reverse geocode ─────────────────────────────────────────
@app.route('/reverse')
def reverse():
    lat = request.args.get('lat', '')
    lon = request.args.get('lon', '')
    url = (
        'https://nominatim.openstreetmap.org/reverse'
        '?format=json&zoom=18&addressdetails=1'
        '&lat=' + lat + '&lon=' + lon
    )
    try:
        data = nominatim_get(url)
        return jsonify(data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ── Proxy: geocode single address ──────────────────────────────────
@app.route('/geocode')
def geocode():
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify([])
    if 'mumbai' not in q.lower() and 'maharashtra' not in q.lower():
        q = q + ', Mumbai'
    url = (
        'https://nominatim.openstreetmap.org/search'
        '?format=json&limit=1&addressdetails=1'
        '&viewbox=' + MUMBAI_VIEWBOX + '&bounded=1'
        '&q=' + urllib.parse.quote(q)
    )
    try:
        data = nominatim_get(url)
        if not data:
            # fallback without viewbox
            url2 = (
                'https://nominatim.openstreetmap.org/search'
                '?format=json&limit=1&countrycodes=in'
                '&q=' + urllib.parse.quote(q)
            )
            data = nominatim_get(url2)
        return jsonify(data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ── Route optimizer ────────────────────────────────────────────────
@app.route('/optimize', methods=['POST'])
def optimize():
    data   = request.get_json(force=True)
    coords = data.get('coords', [])
    if len(coords) < 2:
        return jsonify({"error": "Need at least 2 locations"}), 400
    route = optimize_route(coords)
    return jsonify({"route": route})

if __name__ == '__main__':
    app.run(debug=True)