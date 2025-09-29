// グローバル変数
// duckdb, db, conn, mapはindex.htmlのmoduleスクリプトでwindowにアタッチ済み

function initMap() {
    window.map = new maplibregl.Map({
        container: 'map',
        style: {
            version: 8,
            sources: {
                osm: {
                    type: 'raster',
                    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                    tileSize: 256,
                    attribution: '© OpenStreetMap contributors'
                }
            },
            layers: [{
                id: 'osm',
                type: 'raster',
                source: 'osm'
            }]
        },
        center: [135.758767, 34.985458], // 京都駅
        zoom: 12
    });

    window.map.addControl(new maplibregl.NavigationControl(), 'top-right');
}

window.initializeDuckDB = async function() {
    showLoading(true);
    try {
        const JSDELIVR_BUNDLES = window.duckdb.getJsDelivrBundles();
        const bundle = await window.duckdb.selectBundle(JSDELIVR_BUNDLES);

        const worker_url = URL.createObjectURL(
            new Blob([`importScripts("${bundle.mainWorker}");`], {
                type: "text/javascript",
            })
        );

        const worker = new Worker(worker_url);
        const logger = new window.duckdb.ConsoleLogger();
        window.db = new window.duckdb.AsyncDuckDB(logger, worker);
        await window.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        URL.revokeObjectURL(worker_url);

        window.conn = await window.db.connect();

        // Install spatial extension
        await window.conn.query("INSTALL spatial;");
        await window.conn.query("LOAD spatial;");

        // Install H3 extension
        await window.conn.query("INSTALL h3 FROM community;");
        await window.conn.query("LOAD h3;");

        showStatus('dbStatus', 'データベース: 接続済み ✓');
        showStatus('initStatus', 'DuckDB WASM初期化完了！Spatialエクステンション有効', 'success');
        document.getElementById('loadDataBtn').disabled = false;

    } catch (error) {
        console.error('Init error:', error);
        showStatus('initStatus', `エラー: ${error.message}`, 'error');
    } finally {
        showLoading(false);
    }
}

// Load spatial data
window.loadSpatialData = async function() {
    showLoading(true);
    try {
        // Create sample spatial data for Kyoto
        await conn.query(`
            -- 寺社仏閣テーブル
            CREATE OR REPLACE TABLE temples AS
            SELECT * FROM (VALUES
                ('清水寺', ST_Point(135.7850, 34.9948)),
                ('金閣寺', ST_Point(135.7294, 35.0394)),
                ('銀閣寺', ST_Point(135.7984, 35.0270)),
                ('伏見稲荷大社', ST_Point(135.7727, 34.9671)),
                ('東寺', ST_Point(135.7477, 34.9804)),
                ('龍安寺', ST_Point(135.7183, 35.0345)),
                ('二条城', ST_Point(135.7483, 35.0142)),
                ('平安神宮', ST_Point(135.7823, 35.0160)),
                ('知恩院', ST_Point(135.7826, 35.0053)),
                ('南禅寺', ST_Point(135.7931, 35.0107))
            ) AS t(name, geom);

            -- 駅テーブル
            CREATE OR REPLACE TABLE stations AS
            SELECT * FROM (VALUES
                ('京都駅', ST_Point(135.758767, 34.985458)),
                ('嵐山駅', ST_Point(135.6772, 35.0094)),
                ('祇園四条駅', ST_Point(135.7726, 35.0036)),
                ('河原町駅', ST_Point(135.7690, 35.0090)),
                ('二条駅', ST_Point(135.7413, 35.0106)),
                ('東山駅', ST_Point(135.7760, 35.0094)),
                ('烏丸御池駅', ST_Point(135.7595, 35.0103))
            ) AS t(name, geom);

            -- エリア（区域）テーブル - ポリゴンとして作成
            CREATE OR REPLACE TABLE areas AS
            SELECT * FROM (VALUES
                ('中京区', ST_GeomFromText('POLYGON((135.74 35.00, 135.77 35.00, 135.77 35.02, 135.74 35.02, 135.74 35.00))')),
                ('東山区', ST_GeomFromText('POLYGON((135.77 34.98, 135.80 34.98, 135.80 35.02, 135.77 35.02, 135.77 34.98))')),
                ('下京区', ST_GeomFromText('POLYGON((135.74 34.98, 135.77 34.98, 135.77 35.00, 135.74 35.00, 135.74 34.98))'))
            ) AS t(name, geom);
        `);

        // Add spatial index (conceptual - DuckDB handles this internally)
        await conn.query(`
            -- データ統計を確認
            SELECT
                'temples' as table_name, COUNT(*) as count FROM temples
            UNION ALL
            SELECT
                'stations', COUNT(*) FROM stations
            UNION ALL
            SELECT
                'areas', COUNT(*) FROM areas
        `);

        // 外部GeoJSONファイルからデータを読み込み（3データソース統合）
        const dataFiles = [
            // OpenStreetMapデータ
            { file: 'osm/tourism_temples.geojson', table: 'temples_osm', source: 'OSM' },
            { file: 'osm/restaurants.geojson', table: 'restaurants', source: 'OSM' },
            { file: 'osm/accommodation.geojson', table: 'accommodation', source: 'OSM' },
            { file: 'osm/convenience_stores.geojson', table: 'convenience_stores', source: 'OSM' },
            { file: 'osm/parks_gardens.geojson', table: 'parks', source: 'OSM' },
            { file: 'osm/souvenir_shops.geojson', table: 'souvenirs', source: 'OSM' },
            { file: 'osm/supermarkets.geojson', table: 'supermarkets', source: 'OSM' },
            { file: 'osm/transport.geojson', table: 'transport', source: 'OSM' },

            // PLATEAUデータ（都市インフラ・防災）
            { file: 'plateau/shelters.geojson', table: 'plateau_shelters', source: 'PLATEAU' },
            { file: 'plateau/landmarks.geojson', table: 'plateau_landmarks', source: 'PLATEAU' },
            { file: 'plateau/parks.geojson', table: 'plateau_parks', source: 'PLATEAU' },
            { file: 'plateau/emergency_routes.geojson', table: 'plateau_emergency', source: 'PLATEAU' }
        ];

        for (const { file, table } of dataFiles) {
            try {
                const response = await fetch(`https://raw.githubusercontent.com/kiwamizamurai/chirichiri/main/data/kyoto/${file}`);
                if (response.ok) {
                    const geojson = await response.json();

                    await window.conn.query(`
                        CREATE OR REPLACE TABLE ${table} (
                            id INTEGER,
                            name VARCHAR,
                            geom GEOMETRY
                        )
                    `);

                    // データ挿入（全データを使用）
                    const features = geojson.features;
                    for (let i = 0; i < features.length; i++) {
                        const f = features[i];
                        if (f.geometry.type === 'Point') {
                            const [lng, lat] = f.geometry.coordinates;
                            const name = f.properties.name || f.properties.name_ja || f.properties.name_en || `${table}_${i+1}`;
                            await window.conn.query(`
                                INSERT INTO ${table} VALUES (${i+1}, '${name.replace(/'/g, "''")}', ST_Point(${lng}, ${lat}))
                            `);
                        }
                    }
                    console.log(`Loaded ${features.length} items into ${table}`);
                }
            } catch (error) {
                console.warn(`Could not load ${file}:`, error);
            }
        }

        showStatus('initStatus', '空間データ読み込み完了！', 'success');

    } catch (error) {
        console.error('Load error:', error);
        showStatus('initStatus', `エラー: ${error.message}`, 'error');
    } finally {
        showLoading(false);
    }
}


// Clear all visualization layers from previous demos
window.clearVisualizationLayers = function() {
    // List of all possible visualization layer IDs from demos
    const vizLayerIds = [
        // Distance demo
        'distance-lines', 'distance-circles',
        // Buffer demo
        'buffer-circle', 'buffer-fill',
        // Nearest demo
        'nearest-lines',
        // Grid demo
        'grid-cells', 'grid-lines',
        // H3 demo
        'h3-hexagons', 'h3-hexagons-outline',
        // Convex hull demo
        'convex-hull',
        // Tourist route demo
        'tourist-route',
        // Cluster demo
        'cluster-points'
    ];

    // Remove all existing visualization layers
    vizLayerIds.forEach(id => {
        if (map.getLayer(id)) {
            map.removeLayer(id);
        }
        if (map.getSource(id)) {
            map.removeSource(id);
        }
    });

    // Remove any existing markers
    const markers = document.querySelectorAll('.maplibregl-marker');
    markers.forEach(marker => marker.remove());

    // Reset any centroid marker if it exists
    if (window.centroidMarker) {
        window.centroidMarker.remove();
        window.centroidMarker = null;
    }
}

// All demo functions from original file
window.demoDistance = async function() {
    // Clear all previous visualizations
    clearVisualizationLayers();

    try {
        // Check which tables exist
        const checkResult = await conn.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_name IN ('temples_osm', 'temples', 'transport', 'stations')
        `);
        const availableTables = checkResult.toArray().map(r => r.table_name);

        const templesTable = availableTables.includes('temples_osm') ? 'temples_osm' : 'temples';
        const stationsTable = availableTables.includes('transport') ? 'transport' : 'stations';

        // Use fixed Kyoto Station coordinates if table doesn't have the station
        const kyotoStationLat = 34.985458;
        const kyotoStationLng = 135.758767;

        const sql = `-- 京都駅から各寺社への距離（メートル）
SELECT
    t.name,
    ST_X(t.geom) as lng,
    ST_Y(t.geom) as lat,
    ROUND(ST_Distance(
        t.geom,
        ST_Point(${kyotoStationLng}, ${kyotoStationLat})
    ) * 111000, 0) as distance_m
FROM (
    SELECT * FROM ${templesTable}
    WHERE geom IS NOT NULL
    ORDER BY RANDOM()
    LIMIT 50
) t
ORDER BY distance_m
LIMIT 5`;

        showSQL('distanceSQL', sql);
        const result = await conn.query(sql);
        const data = result.toArray();


    // Draw distance lines from Kyoto Station
    const kyotoStation = [135.758767, 34.985458];
    const lineFeatures = data.map(row => ({
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [kyotoStation, [row.lng, row.lat]]
        },
        properties: {
            name: row.name,
            distance: row.distance_m
        }
    }));

    map.addSource('distance-lines', {
        type: 'geojson',
        data: {
            type: 'FeatureCollection',
            features: lineFeatures
        }
    });

    map.addLayer({
        id: 'distance-lines',
        type: 'line',
        source: 'distance-lines',
        paint: {
            'line-color': '#FF0000',
            'line-width': 2,
            'line-opacity': 0.6
        }
    });

    // Show only relevant columns in result
    await executeAndShow(`
        SELECT
            t.name,
            ROUND(ST_Distance(
                t.geom,
                ST_Point(${kyotoStationLng}, ${kyotoStationLat})
            ) * 111000, 0) as distance_m
        FROM ${templesTable} t
        WHERE t.geom IS NOT NULL
        ORDER BY distance_m
        LIMIT 5
    `, 'distanceResult');
    } catch (error) {
        console.error('Error in demoDistance:', error);
        showStatus('distanceResult', 'エラーが発生しました: ' + error.message, 'error');
    }
}

window.demoBuffer = async function() {
    // Clear all previous visualizations
    clearVisualizationLayers();

    try {
        const radius = document.getElementById('bufferRadius').value;
        const radiusInDegrees = radius / 111000; // Rough conversion

        // Check which tables exist
        const checkResult = await conn.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_name IN ('temples_osm', 'temples')
        `);
        const availableTables = checkResult.toArray().map(r => r.table_name);
        const templesTable = availableTables.includes('temples_osm') ? 'temples_osm' : 'temples';

        // Use fixed Kyoto Station coordinates
        const kyotoStationLat = 34.985458;
        const kyotoStationLng = 135.758767;

        const sql = `-- 京都駅から${radius}mのバッファ内の寺社
SELECT
    t.name,
    CASE
        WHEN ST_Within(
            t.geom,
            ST_Buffer(
                ST_Point(${kyotoStationLng}, ${kyotoStationLat}),
                ${radiusInDegrees}
            )
        ) THEN '圏内'
        ELSE '圏外'
    END as status
FROM ${templesTable} t
WHERE t.geom IS NOT NULL
LIMIT 20`;

        showSQL('bufferSQL', sql);
        await executeAndShow(sql, 'bufferResult');


    // Draw buffer circle on map
    const kyotoStation = [135.758767, 34.985458];
    const points = 64;
    const km = radius / 1000;
    const ret = [];
    const distanceX = km / (111.320 * Math.cos(kyotoStation[1] * Math.PI / 180));
    const distanceY = km / 110.574;

    for (let i = 0; i < points; i++) {
        const theta = (i / points) * (2 * Math.PI);
        const x = distanceX * Math.cos(theta);
        const y = distanceY * Math.sin(theta);
        ret.push([kyotoStation[0] + x, kyotoStation[1] + y]);
    }
    ret.push(ret[0]);

    map.addSource('buffer-fill', {
        type: 'geojson',
        data: {
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [ret]
            }
        }
    });

    map.addLayer({
        id: 'buffer-fill',
        type: 'fill',
        source: 'buffer-fill',
        paint: {
            'fill-color': '#0080FF',
            'fill-opacity': 0.2
        }
    });

    map.addLayer({
        id: 'buffer-circle',
        type: 'line',
        source: 'buffer-fill',
        paint: {
            'line-color': '#0080FF',
            'line-width': 2
        }
    });
    } catch (error) {
        console.error('Error in demoBuffer:', error);
        showStatus('bufferResult', 'エラーが発生しました: ' + error.message, 'error');
    }
}

window.demoNearest = async function() {
    // Clear all previous visualizations
    clearVisualizationLayers();

    // Get coordinates for map visualization
    const fullSql = `-- 各寺社の最寄り駅を検索（座標付き）
WITH distances AS (
    SELECT
        t.name as temple,
        ST_X(t.geom) as temple_lng,
        ST_Y(t.geom) as temple_lat,
        s.name as station,
        ST_X(s.geom) as station_lng,
        ST_Y(s.geom) as station_lat,
        ROUND(ST_Distance(t.geom, s.geom) * 111000, 0) as distance_m,
        ROW_NUMBER() OVER (PARTITION BY t.name ORDER BY ST_Distance(t.geom, s.geom)) as rn
    FROM temples_osm t, transport s
)
SELECT temple, temple_lng, temple_lat, station, station_lng, station_lat, distance_m
FROM distances
WHERE rn = 1
ORDER BY temple`;

    const result = await conn.query(fullSql);
    const data = result.toArray();


    // Draw lines between temples and nearest stations
    const lineFeatures = data.map(row => ({
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [[row.station_lng, row.station_lat], [row.temple_lng, row.temple_lat]]
        },
        properties: {
            temple: row.temple,
            station: row.station,
            distance: row.distance_m
        }
    }));

    map.addSource('nearest-lines', {
        type: 'geojson',
        data: {
            type: 'FeatureCollection',
            features: lineFeatures
        }
    });

    map.addLayer({
        id: 'nearest-lines',
        type: 'line',
        source: 'nearest-lines',
        paint: {
            'line-color': '#008000',
            'line-width': 2,
            'line-opacity': 0.7,
            'line-dasharray': [2, 2]
        }
    });

    // Show simplified result without coordinates
    const displaySql = `-- 各寺社の最寄り駅を検索
WITH distances AS (
    SELECT
        t.name as temple,
        s.name as station,
        ROUND(ST_Distance(t.geom, s.geom) * 111000, 0) as distance_m,
        ROW_NUMBER() OVER (PARTITION BY t.name ORDER BY ST_Distance(t.geom, s.geom)) as rn
    FROM temples_osm t, transport s
)
SELECT temple, station, distance_m
FROM distances
WHERE rn = 1
ORDER BY temple`;

    showSQL('nearestSQL', displaySql);
    await executeAndShow(displaySql, 'nearestResult');
}

window.demoCentroid = async function() {
    // Clear all previous visualizations
    clearVisualizationLayers();

    const sql = `-- すべての観光地の地理的中心点
WITH all_temples AS (
    SELECT
        STRING_AGG(name, ', ') as temples,
        AVG(ST_X(geom)) as center_lng,
        AVG(ST_Y(geom)) as center_lat
    FROM temples_osm
)
SELECT
    'すべての寺社の中心' as description,
    ROUND(center_lng, 4) as lng,
    ROUND(center_lat, 4) as lat
FROM all_temples`;

    showSQL('centroidSQL', sql);

    const mapResult = await conn.query(sql);
    const data = mapResult.toArray()[0];

    const el = document.createElement('div');
    el.style.width = '20px';
    el.style.height = '20px';
    el.style.backgroundColor = '#FF0000';
    el.style.borderRadius = '50%';
    el.style.border = '2px solid white';
    el.style.boxShadow = '0 0 5px rgba(0,0,0,0.5)';

    window.centroidMarker = new maplibregl.Marker({ element: el })
        .setLngLat([data.lng, data.lat])
        .setPopup(new maplibregl.Popup().setHTML(`<strong>地理的中心点</strong><br>緯度: ${data.lat}<br>経度: ${data.lng}`))
        .addTo(map);

    await executeAndShow(sql, 'centroidResult');
}

window.demoSpatialJoin = async function() {
    // Clear all previous visualizations
    clearVisualizationLayers();

    const sql = `-- 空間結合：各駅から500m圏内の寺社
SELECT
    s.name as station,
    t.name as temple,
    ROUND(ST_Distance(s.geom, t.geom) * 111000, 0) as distance_m
FROM transport s
JOIN temples_osm t ON ST_Distance(s.geom, t.geom) < 0.005
ORDER BY s.name, distance_m
LIMIT 10`;

    showSQL('spatialJoinSQL', sql);
    await executeAndShow(sql, 'spatialJoinResult');
}

window.demoServiceArea = async function() {
    // Clear all previous visualizations
    clearVisualizationLayers();

    const sql = `-- 駅の商圏分析（500m圏）
WITH station_areas AS (
    SELECT
        s1.name as station1,
        s2.name as station2,
        CASE
            WHEN ST_Distance(s1.geom, s2.geom) * 111000 < 1000
            THEN '重複あり'
            ELSE '重複なし'
        END as overlap_status,
        ROUND(ST_Distance(s1.geom, s2.geom) * 111000, 0) as distance_m
    FROM transport s1, transport s2
    WHERE s1.name < s2.name
)
SELECT * FROM station_areas
ORDER BY distance_m
LIMIT 5`;

    showSQL('serviceAreaSQL', sql);
    await executeAndShow(sql, 'serviceAreaResult');
}

window.demoWithin = async function() {
    // Clear all previous visualizations
    clearVisualizationLayers();

    const sql = `-- 東山区内の観光施設
SELECT
    t.name as temple,
    a.name as area,
    CASE
        WHEN ST_Within(t.geom, a.geom) THEN '区内'
        ELSE '区外'
    END as status
FROM temples_osm t, areas a
WHERE a.name = '東山区'`;

    showSQL('withinSQL', sql);
    await executeAndShow(sql, 'withinResult');
}

window.demoSpatialAgg = async function() {
    // Clear all previous visualizations
    clearVisualizationLayers();

    const sql = `-- 500mグリッドで施設密度
WITH grid_data AS (
    SELECT
        ROUND(ST_X(geom) * 200) / 200 as grid_lng,
        ROUND(ST_Y(geom) * 200) / 200 as grid_lat,
        COUNT(*) as count
    FROM (
        SELECT geom FROM temples_osm
        UNION ALL
        SELECT geom FROM transport
    ) all_points
    GROUP BY grid_lng, grid_lat
)
SELECT
    CONCAT('Grid[', ROUND(grid_lng, 3), ',', ROUND(grid_lat, 3), ']') as grid_id,
    count as poi_count,
    CASE
        WHEN count >= 3 THEN '高密度'
        WHEN count >= 2 THEN '中密度'
        ELSE '低密度'
    END as density_level
FROM grid_data
ORDER BY count DESC`;

    showSQL('spatialAggSQL', sql);
    await executeAndShow(sql, 'spatialAggResult');
}

window.demoGrid = async function() {
    // Clear all previous visualizations
    clearVisualizationLayers();

    const fullSql = `-- 250mグリッド分析（座標付き）
WITH grid_analysis AS (
    SELECT
        ROUND(ST_X(geom) * 400) / 400 as grid_lng,
        ROUND(ST_Y(geom) * 400) / 400 as grid_lat,
        COUNT(*) as poi_count
    FROM (
        SELECT geom FROM temples_osm
        UNION ALL
        SELECT geom FROM transport
    ) all_poi
    GROUP BY ROUND(ST_X(geom) * 400) / 400, ROUND(ST_Y(geom) * 400) / 400
)
SELECT
    grid_lng,
    grid_lat,
    poi_count
FROM grid_analysis`;

    const result = await conn.query(fullSql);
    const data = result.toArray();


    // Create grid cells
    const gridSize = 1/400; // 250m in degrees
    const gridFeatures = data.map(row => {
        const coords = [
            [row.grid_lng - gridSize/2, row.grid_lat - gridSize/2],
            [row.grid_lng + gridSize/2, row.grid_lat - gridSize/2],
            [row.grid_lng + gridSize/2, row.grid_lat + gridSize/2],
            [row.grid_lng - gridSize/2, row.grid_lat + gridSize/2],
            [row.grid_lng - gridSize/2, row.grid_lat - gridSize/2]
        ];

        return {
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [coords]
            },
            properties: {
                count: Number(row.poi_count),
                opacity: Math.min(Number(row.poi_count) * 0.2, 0.8)
            }
        };
    });

    map.addSource('grid-cells', {
        type: 'geojson',
        data: {
            type: 'FeatureCollection',
            features: gridFeatures
        }
    });

    map.addLayer({
        id: 'grid-cells',
        type: 'fill',
        source: 'grid-cells',
        paint: {
            'fill-color': '#FF6B6B',
            'fill-opacity': ['get', 'opacity']
        }
    });

    map.addLayer({
        id: 'grid-lines',
        type: 'line',
        source: 'grid-cells',
        paint: {
            'line-color': '#666',
            'line-width': 1,
            'line-opacity': 0.5
        }
    });

    // Show display result
    const displaySql = `-- 250mグリッド分析
WITH grid_analysis AS (
    SELECT
        ROUND(ST_X(geom) * 400) / 400 as grid_lng,
        ROUND(ST_Y(geom) * 400) / 400 as grid_lat,
        'temple' as type,
        COUNT(*) as count
    FROM temples_osm
    GROUP BY ROUND(ST_X(geom) * 400) / 400, ROUND(ST_Y(geom) * 400) / 400
    UNION ALL
    SELECT
        ROUND(ST_X(geom) * 400) / 400 as grid_lng,
        ROUND(ST_Y(geom) * 400) / 400 as grid_lat,
        'station' as type,
        COUNT(*) as count
    FROM transport
    GROUP BY ROUND(ST_X(geom) * 400) / 400, ROUND(ST_Y(geom) * 400) / 400
)
SELECT
    CONCAT('[', ROUND(grid_lng, 4), ',', ROUND(grid_lat, 4), ']') as grid,
    type,
    count
FROM grid_analysis
ORDER BY count DESC
LIMIT 10`;

    showSQL('gridSQL', displaySql);
    const displayResult = await conn.query(displaySql);
    await executeAndShow(displaySql, 'gridResult');
}

window.demoPredicates = async function() {
    // Clear all previous visualizations
    clearVisualizationLayers();

    try {
        // Check which tables exist
        const checkResult = await conn.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_name IN ('temples_osm', 'temples')
        `);
        const availableTables = checkResult.toArray().map(r => r.table_name);
        const templesTable = availableTables.includes('temples_osm') ? 'temples_osm' : 'temples';

        // Use fixed Kyoto Station coordinates
        const kyotoStationLat = 34.985458;
        const kyotoStationLng = 135.758767;

        const sql = `-- 京都駅1km圏の内外判定
SELECT
    t.name,
    ROUND(ST_Distance(t.geom, ST_Point(${kyotoStationLng}, ${kyotoStationLat})) * 111000, 0) as distance_m,
    CASE
        WHEN ST_Distance(t.geom, ST_Point(${kyotoStationLng}, ${kyotoStationLat})) * 111000 <= 1000 THEN '圏内'
        ELSE '圏外'
    END as status,
    CASE
        WHEN ST_Distance(t.geom, ST_Point(${kyotoStationLng}, ${kyotoStationLat})) * 111000 <= 500 THEN '徒歩5分'
        WHEN ST_Distance(t.geom, ST_Point(${kyotoStationLng}, ${kyotoStationLat})) * 111000 <= 1000 THEN '徒歩10分'
        WHEN ST_Distance(t.geom, ST_Point(${kyotoStationLng}, ${kyotoStationLat})) * 111000 <= 2000 THEN '徒歩20分'
        ELSE 'バス・電車'
    END as access
FROM ${templesTable} t
WHERE t.geom IS NOT NULL
ORDER BY distance_m
LIMIT 10`;

        showSQL('predicatesSQL', sql);
        await executeAndShow(sql, 'predicatesResult');
    } catch (error) {
        console.error('Error in demoPredicates:', error);
        showStatus('predicatesResult', 'エラーが発生しました: ' + error.message, 'error');
    }
}

window.demoH3Grid = async function() {
    // Clear all previous visualizations
    clearVisualizationLayers();

    const sql = `-- H3六角形グリッド分析（DuckDB H3拡張使用）
-- 解像度8: 約460m六角形（詳細な都市分析に適切）
WITH all_pois AS (
    -- POIデータを結合（メモリ制限のため件数制限）
    (SELECT name, geom FROM temples_osm LIMIT 50)
    UNION ALL
    (SELECT name, geom FROM transport LIMIT 50)
    UNION ALL
    (SELECT name, geom FROM restaurants LIMIT 30)
    UNION ALL
    (SELECT name, geom FROM accommodation LIMIT 20)
    UNION ALL
    (SELECT name, geom FROM plateau_shelters LIMIT 20)
    UNION ALL
    (SELECT name, geom FROM plateau_landmarks LIMIT 20)
),
poi_h3 AS (
    -- 各POIを解像度8のH3セルに変換
    SELECT
        name,
        h3_latlng_to_cell(ST_Y(geom), ST_X(geom), 8) as h3_index,
        geom
    FROM all_pois
),
h3_aggregation AS (
    -- H3セルごとにPOI数を集計
    SELECT
        h3_index,
        COUNT(*) as poi_count,
        h3_cell_to_lat(h3_index) as lat,
        h3_cell_to_lng(h3_index) as lng,
        STRING_AGG(name, ', ') as poi_names
    FROM poi_h3
    GROUP BY h3_index
)
SELECT
    h3_index,
    ROUND(lng, 4) as lng,
    ROUND(lat, 4) as lat,
    poi_count,
    CASE
        WHEN poi_count >= 3 THEN '高密度'
        WHEN poi_count >= 2 THEN '中密度'
        ELSE '低密度'
    END as density_level,
    poi_names
FROM h3_aggregation
ORDER BY poi_count DESC
LIMIT 10`;

    showSQL('h3GridSQL', sql);
    const result = await conn.query(sql);
    const data = result.toArray();

    try {
        const boundaryResult = await conn.query(`
            WITH all_pois AS (
                -- POIデータを結合（メモリ制限のため件数制限）
                (SELECT name, geom FROM temples_osm LIMIT 50)
                UNION ALL
                (SELECT name, geom FROM transport LIMIT 50)
                UNION ALL
                (SELECT name, geom FROM restaurants LIMIT 30)
                UNION ALL
                (SELECT name, geom FROM accommodation LIMIT 20)
                UNION ALL
                (SELECT name, geom FROM plateau_shelters LIMIT 20)
                UNION ALL
                (SELECT name, geom FROM plateau_landmarks LIMIT 20)
            ),
            poi_h3 AS (
                SELECT
                    name,
                    h3_latlng_to_cell(ST_Y(geom), ST_X(geom), 8) as h3_index
                FROM all_pois
            ),
            h3_cells AS (
                SELECT
                    h3_index,
                    COUNT(*) as poi_count,
                    h3_cell_to_lat(h3_index) as lat,
                    h3_cell_to_lng(h3_index) as lng
                FROM poi_h3
                GROUP BY h3_index
            )
            SELECT
                h3_index,
                poi_count,
                lat,
                lng
            FROM h3_cells
        `);

        const boundaryData = boundaryResult.toArray();

        const hexRadius = 0.002;
        const hexFeatures = boundaryData.map(row => {
            const centerLng = row.lng;
            const centerLat = row.lat;

            const coords = [];
            for (let i = 0; i < 7; i++) {
                const angle = (Math.PI / 3) * i;
                const lng = centerLng + hexRadius * Math.cos(angle) * 1.5;
                const lat = centerLat + hexRadius * Math.sin(angle);
                coords.push([lng, lat]);
            }

            return {
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [coords]
                },
                properties: {
                    count: Number(row.poi_count),
                    opacity: Math.min(Number(row.poi_count) * 0.3, 0.9),
                    fillColor: Number(row.poi_count) >= 3 ? '#6A1B9A' :
                              Number(row.poi_count) >= 2 ? '#8E24AA' : '#AB47BC'
                }
            };
        });

        map.addSource('h3-hexagons', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: hexFeatures
            }
        });

        map.addLayer({
            id: 'h3-hexagons',
            type: 'fill',
            source: 'h3-hexagons',
            paint: {
                'fill-color': ['get', 'fillColor'],
                'fill-opacity': ['get', 'opacity'],
                'fill-outline-color': '#4A148C'
            }
        });

        map.addLayer({
            id: 'h3-hexagons-outline',
            type: 'line',
            source: 'h3-hexagons',
            paint: {
                'line-color': '#4A148C',
                'line-width': 2
            }
        });
    } catch (vizError) {
    }

    await executeAndShow(sql, 'h3GridResult');
}

window.demoConvexHull = async function() {
    // Clear all previous visualizations
    clearVisualizationLayers();

    const sql = `-- 観光地群の凸包（外周）を計算
WITH temple_points AS (
    SELECT
        'すべての寺社' as group_name,
        COUNT(*) as point_count,
        -- 凸包の頂点を近似計算
        MIN(ST_X(geom)) as min_lng,
        MAX(ST_X(geom)) as max_lng,
        MIN(ST_Y(geom)) as min_lat,
        MAX(ST_Y(geom)) as max_lat,
        AVG(ST_X(geom)) as center_lng,
        AVG(ST_Y(geom)) as center_lat
    FROM temples_osm
)
SELECT
    group_name,
    point_count,
    ROUND((max_lng - min_lng) * 111, 2) as width_km,
    ROUND((max_lat - min_lat) * 111, 2) as height_km,
    ROUND(width_km * height_km, 2) as area_km2,
    ROUND(center_lng, 4) as center_lng,
    ROUND(center_lat, 4) as center_lat
FROM temple_points`;

    showSQL('convexHullSQL', sql);
    const result = await conn.query(sql);
    const data = result.toArray()[0];

    const templesResult = await conn.query(`
        SELECT ST_X(geom) as lng, ST_Y(geom) as lat
        FROM temples_osm
        ORDER BY ST_X(geom), ST_Y(geom)
    `);
    const temples = templesResult.toArray();

    const hull = [];
    const leftmost = temples.reduce((min, p) => p.lng < min.lng ? p : min);
    const rightmost = temples.reduce((max, p) => p.lng > max.lng ? p : max);
    const topmost = temples.reduce((max, p) => p.lat > max.lat ? p : max);
    const bottommost = temples.reduce((min, p) => p.lat < min.lat ? p : min);

    hull.push([leftmost.lng, leftmost.lat]);
    hull.push([bottommost.lng, bottommost.lat]);
    hull.push([rightmost.lng, rightmost.lat]);
    hull.push([topmost.lng, topmost.lat]);
    hull.push([leftmost.lng, leftmost.lat]);


    map.addSource('convex-hull', {
        type: 'geojson',
        data: {
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [hull]
            }
        }
    });

    map.addLayer({
        id: 'convex-hull',
        type: 'line',
        source: 'convex-hull',
        paint: {
            'line-color': '#E91E63',
            'line-width': 3,
            'line-dasharray': [5, 5]
        }
    });

    await executeAndShow(sql, 'convexHullResult');
}

window.demoVoronoi = async function() {
    // Clear all previous visualizations
    clearVisualizationLayers();

    const sql = `-- ボロノイ図による駅の勢力圏分析
-- 各地点から最寄り駅を判定
WITH distance_matrix AS (
    SELECT
        t.name as location,
        s.name as nearest_station,
        ST_Distance(t.geom, s.geom) * 111000 as distance_m,
        ROW_NUMBER() OVER (PARTITION BY t.name ORDER BY ST_Distance(t.geom, s.geom)) as rank
    FROM temples_osm t, transport s
),
voronoi_cells AS (
    SELECT
        nearest_station,
        COUNT(*) as locations_in_cell,
        AVG(distance_m) as avg_distance_m,
        MIN(distance_m) as min_distance_m,
        MAX(distance_m) as max_distance_m
    FROM distance_matrix
    WHERE rank = 1
    GROUP BY nearest_station
)
SELECT
    nearest_station as station,
    locations_in_cell as temples_count,
    ROUND(avg_distance_m, 0) as avg_dist_m,
    ROUND(min_distance_m, 0) as min_dist_m,
    ROUND(max_distance_m, 0) as max_dist_m
FROM voronoi_cells
ORDER BY locations_in_cell DESC`;

    showSQL('voronoiSQL', sql);
    await executeAndShow(sql, 'voronoiResult');

    // Visualize Voronoi regions by coloring temples by nearest station
    const assignmentResult = await conn.query(`
        WITH assignments AS (
            SELECT
                t.name as temple,
                ST_X(t.geom) as lng,
                ST_Y(t.geom) as lat,
                s.name as station,
                ROW_NUMBER() OVER (PARTITION BY t.name ORDER BY ST_Distance(t.geom, s.geom)) as rank
            FROM temples_osm t, transport s
        )
        SELECT temple, lng, lat, station
        FROM assignments
        WHERE rank = 1
    `);

    const assignments = assignmentResult.toArray();
    const stationColors = {
        '京都駅': '#FF0000',
        '嵐山駅': '#00FF00',
        '祇園四条駅': '#0000FF',
        '河原町駅': '#FF00FF',
        '二条駅': '#00FFFF',
        '東山駅': '#FFFF00',
        '烏丸御池駅': '#FF8000'
    };

    // Add colored markers
    assignments.forEach(a => {
        const color = stationColors[a.station] || '#808080';
        const el = document.createElement('div');
        el.style.width = '10px';
        el.style.height = '10px';
        el.style.backgroundColor = color;
        el.style.borderRadius = '50%';
        el.style.border = '1px solid white';

        new maplibregl.Marker({ element: el })
            .setLngLat([a.lng, a.lat])
            .setPopup(new maplibregl.Popup().setHTML(`<strong>${a.temple}</strong><br>最寄駅: ${a.station}`))
            .addTo(map);
    });
}

window.demoOutlierDetection = async function() {
    // Clear all previous visualizations
    clearVisualizationLayers();

    const sql = `-- 孤立した施設の検出
WITH nearest_distances AS (
    -- 各施設から最寄り施設への距離を計算
    SELECT
        t1.name,
        ST_X(t1.geom) as lng,
        ST_Y(t1.geom) as lat,
        MIN(ST_Distance(t1.geom, t2.geom)) * 111000 as nearest_m
    FROM temples_osm t1, temples_osm t2
    WHERE t1.name != t2.name
    GROUP BY t1.name, t1.geom
),
stats AS (
    SELECT
        AVG(nearest_m) as avg_dist,
        STDDEV(nearest_m) as std_dist
    FROM nearest_distances
)
SELECT
    nd.name,
    ROUND(nd.lng, 4) as lng,
    ROUND(nd.lat, 4) as lat,
    ROUND(nd.nearest_m, 0) as "最寄りまでの距離(m)",
    CASE
        WHEN nd.nearest_m > s.avg_dist + s.std_dist * 2 THEN '孤立'
        WHEN nd.nearest_m > s.avg_dist + s.std_dist THEN 'やや孤立'
        ELSE '通常'
    END as status
FROM nearest_distances nd, stats s
ORDER BY nd.nearest_m DESC`;

    showSQL('outlierSQL', sql);
    const result = await conn.query(sql);
    const data = result.toArray();

    // Highlight outliers on map
    data.filter(d => d.status.includes('外れ値')).forEach(outlier => {
        // Add a special marker for outliers
        const el = document.createElement('div');
        el.style.width = '20px';
        el.style.height = '20px';
        el.style.backgroundColor = '#FFC107';
        el.style.borderRadius = '50%';
        el.style.border = '3px solid #FF5722';
        el.style.boxShadow = '0 0 10px rgba(255,87,34,0.8)';

        new maplibregl.Marker({ element: el })
            .setLngLat([outlier.lng, outlier.lat])
            .setPopup(new maplibregl.Popup().setHTML(
                `<strong>${outlier.name}</strong><br>` +
                `状態: ${outlier.status}<br>` +
                `最近隣距離: ${outlier.nearest_m}m<br>` +
                `Zスコア: ${outlier.z_score}`
            ))
            .addTo(map);
    });

    await executeAndShow(sql, 'outlierResult');
}

window.demoLineAnalysis = async function() {
    // Clear all previous visualizations
    clearVisualizationLayers();

    const sql = `-- 観光ルート分析
WITH route_points AS (
    -- 京都駅から近い順に観光地を訪問
    SELECT
        ROW_NUMBER() OVER (ORDER BY ST_Distance(ST_Point(135.758767, 34.985458), geom)) as order_num,
        name,
        ST_X(geom) as lng,
        ST_Y(geom) as lat,
        ST_Distance(ST_Point(135.758767, 34.985458), geom) * 111000 as distance_from_station
    FROM temples_osm
    WHERE name IN ('清水寺', '伏見稲荷大社', '東寺', '二条城', '平安神宮')
),
route_segments AS (
    -- 各区間の距離を計算
    SELECT
        p1.order_num,
        p1.name as from_place,
        p2.name as to_place,
        ST_Distance(ST_Point(p1.lng, p1.lat), ST_Point(p2.lng, p2.lat)) * 111000 as segment_distance
    FROM route_points p1
    JOIN route_points p2 ON p1.order_num = p2.order_num - 1
)
SELECT
    order_num as "順番",
    from_place || ' → ' || to_place as "区間",
    ROUND(segment_distance, 0) as "距離(m)",
    ROUND(SUM(segment_distance) OVER (ORDER BY order_num), 0) as "累積距離(m)"
FROM route_segments
ORDER BY order_num`;

    showSQL('lineSQL', sql);

    const routeResult = await conn.query(`
        SELECT
            ROW_NUMBER() OVER (ORDER BY ST_Distance(ST_Point(135.758767, 34.985458), geom)) as order_num,
            name,
            ST_X(geom) as lng,
            ST_Y(geom) as lat
        FROM temples_osm
        WHERE name IN ('清水寺', '伏見稲荷大社', '東寺', '二条城', '平安神宮')
    `);

    const routePoints = routeResult.toArray();
    const routeCoords = [[135.758767, 34.985458]]; // 京都駅から開始
    routePoints.forEach(p => routeCoords.push([p.lng, p.lat]));


    map.addSource('tourist-route', {
        type: 'geojson',
        data: {
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: routeCoords
            }
        }
    });

    map.addLayer({
        id: 'tourist-route',
        type: 'line',
        source: 'tourist-route',
        paint: {
            'line-color': '#2196F3',
            'line-width': 3,
            'line-opacity': 0.7
        }
    });

    await executeAndShow(sql, 'lineResult');
}

window.demoDBSCAN = async function() {
    // Clear all previous visualizations
    clearVisualizationLayers();

    const sql = `-- 密度ベースクラスタリング
WITH density_analysis AS (
    -- 500m圏内の近隣施設数をカウント（メモリ制限のため件数制限）
    SELECT
        p1.name,
        ST_X(p1.geom) as lng,
        ST_Y(p1.geom) as lat,
        COUNT(p2.name) as neighbors_500m,
        CASE
            WHEN COUNT(p2.name) >= 3 THEN 'コアポイント'
            WHEN COUNT(p2.name) >= 2 THEN 'ボーダーポイント'
            ELSE 'ノイズポイント'
        END as point_type
    FROM (
        (SELECT name, geom FROM temples_osm LIMIT 50)
        UNION ALL
        (SELECT name, geom FROM transport LIMIT 50)
    ) p1
    LEFT JOIN (
        (SELECT name, geom FROM temples_osm LIMIT 50)
        UNION ALL
        (SELECT name, geom FROM transport LIMIT 50)
    ) p2
    ON p1.name != p2.name
        AND ST_Distance(p1.geom, p2.geom) * 111000 < 500
    GROUP BY p1.name, p1.geom
),
clusters AS (
    SELECT
        point_type,
        COUNT(*) as point_count,
        AVG(neighbors_500m) as avg_neighbors,
        MIN(lng) as min_lng,
        MAX(lng) as max_lng,
        MIN(lat) as min_lat,
        MAX(lat) as max_lat
    FROM density_analysis
    GROUP BY point_type
)
SELECT
    point_type as "ポイント種別",
    point_count as "施設数",
    ROUND(avg_neighbors, 1) as "平均近隣数",
    ROUND((max_lng - min_lng) * 111, 2) as "東西幅(km)",
    ROUND((max_lat - min_lat) * 111, 2) as "南北幅(km)"
FROM clusters
ORDER BY avg_neighbors DESC`;

    showSQL('dbscanSQL', sql);

    const clusterResult = await conn.query(`
        WITH density_analysis AS (
            SELECT
                p1.name,
                ST_X(p1.geom) as lng,
                ST_Y(p1.geom) as lat,
                COUNT(p2.name) as neighbors_500m
            FROM (
                (SELECT name, geom FROM temples_osm LIMIT 50)
                UNION ALL
                (SELECT name, geom FROM transport LIMIT 50)
            ) p1
            LEFT JOIN (
                (SELECT name, geom FROM temples_osm LIMIT 50)
                UNION ALL
                (SELECT name, geom FROM transport LIMIT 50)
            ) p2
            ON p1.name != p2.name
                AND ST_Distance(p1.geom, p2.geom) * 111000 < 500
            GROUP BY p1.name, p1.geom
        )
        SELECT name, lng, lat, neighbors_500m,
            CASE
                WHEN neighbors_500m >= 3 THEN 'core'
                WHEN neighbors_500m >= 2 THEN 'border'
                ELSE 'noise'
            END as cluster_type
        FROM density_analysis
    `);

    const clusterData = clusterResult.toArray();

    const clusterFeatures = clusterData.map(point => {
        const colorMap = {
            'core': '#FF5722',
            'border': '#FFC107',
            'noise': '#9E9E9E'
        };

        return {
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [point.lng, point.lat]
            },
            properties: {
                name: point.name,
                cluster_type: point.cluster_type,
                neighbors: Number(point.neighbors_500m),
                color: colorMap[point.cluster_type],
                radius: point.cluster_type === 'core' ? 12 :
                        point.cluster_type === 'border' ? 8 : 5
            }
        };
    });

    map.addSource('cluster-points', {
        type: 'geojson',
        data: {
            type: 'FeatureCollection',
            features: clusterFeatures
        }
    });

    map.addLayer({
        id: 'cluster-points',
        type: 'circle',
        source: 'cluster-points',
        paint: {
            'circle-radius': ['get', 'radius'],
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 2
        }
    });

    map.on('click', 'cluster-points', (e) => {
        const properties = e.features[0].properties;
        new maplibregl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(`
                <strong>${properties.name}</strong><br>
                クラスタ種別: ${properties.cluster_type}<br>
                近隣数: ${properties.neighbors}
            `)
            .addTo(map);
    });

    await executeAndShow(sql, 'dbscanResult');
}

window.executeCustomSQL = async function() {
    const sql = document.getElementById('customSQL').value;
    await executeAndShow(sql, 'customResult');
}

// データレイヤー管理
const dataLayers = {
    temples: { color: '#FF6B6B', loaded: false },
    stations: { color: '#4ECDC4', loaded: false },
    restaurants: { color: '#FFA500', loaded: false },
    accommodation: { color: '#9C27B0', loaded: false },
    convenience: { color: '#00BCD4', loaded: false },
    parks: { color: '#4CAF50', loaded: false },
    souvenirs: { color: '#E91E63', loaded: false },
    supermarkets: { color: '#795548', loaded: false },
    // PLATEAU
    plateau_shelters: { color: '#FF0000', loaded: false },
    plateau_landmarks: { color: '#0000FF', loaded: false },
    plateau_parks: { color: '#00FF00', loaded: false },
    plateau_emergency: { color: '#FF00FF', loaded: false }
};

window.toggleDataLayer = async function(layerName) {
    const btn = document.querySelector(`[data-layer="${layerName}"]`);

    if (dataLayers[layerName].loaded) {
        // レイヤーを削除
        if (map.getLayer(`${layerName}-markers`)) {
            map.removeLayer(`${layerName}-markers`);
        }
        if (map.getSource(`${layerName}-source`)) {
            map.removeSource(`${layerName}-source`);
        }
        dataLayers[layerName].loaded = false;
        btn.classList.remove('active');
    } else {
        // レイヤーを追加
        try {
            let tableName = layerName;
            let query = '';

            // テーブル名とクエリの調整
            switch(layerName) {
                case 'restaurants':
                    query = `SELECT name, ST_X(geom) as lng, ST_Y(geom) as lat FROM restaurants`;
                    break;
                case 'accommodation':
                    query = `SELECT name, ST_X(geom) as lng, ST_Y(geom) as lat FROM accommodation`;
                    break;
                case 'convenience':
                    query = `SELECT name, ST_X(geom) as lng, ST_Y(geom) as lat FROM convenience_stores`;
                    break;
                case 'parks':
                    query = `SELECT name, ST_X(geom) as lng, ST_Y(geom) as lat FROM parks`;
                    break;
                case 'souvenirs':
                    query = `SELECT name, ST_X(geom) as lng, ST_Y(geom) as lat FROM souvenirs`;
                    break;
                case 'supermarkets':
                    query = `SELECT name, ST_X(geom) as lng, ST_Y(geom) as lat FROM supermarkets`;
                    break;
                default:
                    query = `SELECT name, ST_X(geom) as lng, ST_Y(geom) as lat FROM ${layerName}`;
            }

            const result = await conn.query(query);
            const data = result.toArray();

            const features = data.map(item => ({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [item.lng, item.lat]
                },
                properties: {
                    name: item.name
                }
            }));

            map.addSource(`${layerName}-source`, {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: features
                }
            });

            map.addLayer({
                id: `${layerName}-markers`,
                type: 'circle',
                source: `${layerName}-source`,
                paint: {
                    'circle-radius': 6,
                    'circle-color': dataLayers[layerName].color,
                    'circle-stroke-color': '#fff',
                    'circle-stroke-width': 2
                }
            });

            // ポップアップの追加
            map.on('click', `${layerName}-markers`, (e) => {
                const properties = e.features[0].properties;
                new maplibregl.Popup()
                    .setLngLat(e.lngLat)
                    .setHTML(`<strong>${properties.name}</strong>`)
                    .addTo(map);
            });

            dataLayers[layerName].loaded = true;
            btn.classList.add('active');
        } catch (error) {
            console.error(`Error loading ${layerName}:`, error);
            alert(`${layerName}データの読み込みに失敗しました`);
        }
    }
}

window.clearAllLayers = function() {
    Object.keys(dataLayers).forEach(layerName => {
        if (dataLayers[layerName].loaded) {
            if (map.getLayer(`${layerName}-markers`)) {
                map.removeLayer(`${layerName}-markers`);
            }
            if (map.getSource(`${layerName}-source`)) {
                map.removeSource(`${layerName}-source`);
            }
            dataLayers[layerName].loaded = false;
            const btn = document.querySelector(`[data-layer="${layerName}"]`);
            if (btn) btn.classList.remove('active');
        }
    });
}

async function executeAndShow(sql, resultId) {
    try {
        const result = await conn.query(sql);
        const rows = result.toArray();

        if (rows.length === 0) {
            document.getElementById(resultId).textContent = '結果なし';
            return;
        }

        let output = '';
        const columns = Object.keys(rows[0]);

        output += columns.join(' | ') + '\n';
        output += columns.map(c => '-'.repeat(Math.max(c.length, 10))).join('-|-') + '\n';
        rows.forEach(row => {
            output += columns.map(col => {
                const val = row[col];
                if (val === null || val === undefined) return 'NULL';
                if (typeof val === 'number') return val.toFixed(2);
                return String(val);
            }).join(' | ') + '\n';
        });

        document.getElementById(resultId).textContent = output;
    } catch (error) {
        document.getElementById(resultId).textContent = `エラー: ${error.message}`;
    }
}

function showSQL(elementId, sql) {
    const element = document.getElementById(elementId);
    if (element) {
        // Prism.jsを使用する場合
        if (typeof Prism !== 'undefined') {
            element.innerHTML = `<pre><code class="language-sql">${escapeHtml(sql)}</code></pre>`;
            Prism.highlightElement(element.querySelector('code'));
        } else {
            // Prism.jsがない場合はプレーンテキストとして表示
            element.textContent = sql;
        }
    }
}

function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

function showStatus(elementId, message, type = '') {
    const element = document.getElementById(elementId);
    if (element) {
        if (type) {
            element.className = `status ${type}`;
        }
        element.textContent = message;
    }
}

function showLoading(show) {
    document.getElementById('loading').className = show ? 'loading active' : 'loading';
}

window.switchTab = function(tabName) {
    // Update tabs
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    event.target.classList.add('active');

    // Update content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(tabName + 'Tab').classList.add('active');
}

window.addEventListener('load', () => {
    initMap();
});