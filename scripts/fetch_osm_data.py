#!/usr/bin/env python3
"""
Fetch POI data from OpenStreetMap for Kyoto City using Overpass API
"""
import json
import requests
import os
import time
from typing import Dict, Any

def osm_to_geojson(osm_data: Dict[str, Any]) -> Dict[str, Any]:
    """Convert OSM data to GeoJSON format"""
    features = []
    nodes = {}

    # Store nodes in dictionary
    for element in osm_data.get('elements', []):
        if element['type'] == 'node':
            nodes[element['id']] = element

    # Convert nodes and ways to GeoJSON features
    for element in osm_data.get('elements', []):
        if element['type'] == 'node' and 'tags' in element:
            properties = element.get('tags', {})
            if 'name:ja' in properties:
                properties['name'] = properties['name:ja']

            feature = {
                'type': 'Feature',
                'geometry': {
                    'type': 'Point',
                    'coordinates': [element['lon'], element['lat']]
                },
                'properties': properties
            }
            features.append(feature)

        elif element['type'] == 'way' and 'tags' in element:
            if 'nodes' in element and len(element['nodes']) > 0:
                coords = []
                for node_id in element['nodes']:
                    if node_id in nodes:
                        node = nodes[node_id]
                        coords.append([node['lon'], node['lat']])

                if coords:
                    properties = element.get('tags', {})
                    if 'name:ja' in properties:
                        properties['name'] = properties['name:ja']

                    feature = {
                        'type': 'Feature',
                        'geometry': {
                            'type': 'Point',
                            'coordinates': coords[0]
                        },
                        'properties': properties
                    }
                    features.append(feature)

    return {
        'type': 'FeatureCollection',
        'features': features
    }

def fetch_kyoto_data(query: str, filename: str, description: str) -> bool:
    """Fetch data from Overpass API"""
    overpass_url = "http://overpass-api.de/api/interpreter"

    print(f"  Fetching {description}...")
    try:
        response = requests.get(
            overpass_url,
            params={'data': query},
            timeout=180
        )

        if response.status_code == 200:
            osm_data = response.json()
            geojson_data = osm_to_geojson(osm_data)

            with open(filename, 'w', encoding='utf-8') as f:
                json.dump(geojson_data, f, ensure_ascii=False, indent=2)

            print(f"    ✓ Saved {len(geojson_data['features'])} features: {filename}")
            return True
        else:
            print(f"    ✗ Error: HTTP {response.status_code}")
            return False

    except Exception as e:
        print(f"    ✗ Error: {e}")
        return False

def main():
    """Main process"""
    print("="*60)
    print(" OpenStreetMap Data Fetch - Kyoto City")
    print("="*60)

    os.makedirs('data/kyoto/osm', exist_ok=True)

    datasets = [
        {
            'name': '観光地・寺社仏閣',
            'file': 'data/kyoto/osm/tourism_temples.geojson',
            'query': """
                [out:json][timeout:180];
                area["name"="京都市"]["admin_level"="7"]->.searchArea;
                (
                  node["tourism"](area.searchArea);
                  way["tourism"](area.searchArea);
                  node["amenity"="place_of_worship"](area.searchArea);
                  way["amenity"="place_of_worship"](area.searchArea);
                  node["historic"](area.searchArea);
                  way["historic"](area.searchArea);
                );
                out body;
                >;
                out skel qt;
            """
        },
        {
            'name': '飲食店',
            'file': 'data/kyoto/osm/restaurants.geojson',
            'query': """
                [out:json][timeout:180];
                area["name"="京都市"]["admin_level"="7"]->.searchArea;
                (
                  node["amenity"~"restaurant|cafe|fast_food|bar|pub"](area.searchArea);
                  way["amenity"~"restaurant|cafe|fast_food|bar|pub"](area.searchArea);
                );
                out body;
                >;
                out skel qt;
            """
        },
        {
            'name': '宿泊施設',
            'file': 'data/kyoto/osm/accommodation.geojson',
            'query': """
                [out:json][timeout:120];
                area["name"="京都市"]["admin_level"="7"]->.searchArea;
                (
                  node["tourism"~"hotel|hostel|guest_house|motel"](area.searchArea);
                  way["tourism"~"hotel|hostel|guest_house|motel"](area.searchArea);
                );
                out body;
                >;
                out skel qt;
            """
        },
        {
            'name': '公共交通',
            'file': 'data/kyoto/osm/transport.geojson',
            'query': """
                [out:json][timeout:120];
                area["name"="京都市"]["admin_level"="7"]->.searchArea;
                (
                  node["railway"="station"](area.searchArea);
                  way["railway"="station"](area.searchArea);
                  node["highway"="bus_stop"](area.searchArea);
                );
                out body;
                >;
                out skel qt;
            """
        },
        {
            'name': 'コンビニエンスストア',
            'file': 'data/kyoto/osm/convenience_stores.geojson',
            'query': """
                [out:json][timeout:120];
                area["name"="京都市"]["admin_level"="7"]->.searchArea;
                (
                  node["shop"="convenience"](area.searchArea);
                  way["shop"="convenience"](area.searchArea);
                );
                out body;
                >;
                out skel qt;
            """
        }
    ]

    total_features = 0
    for dataset in datasets:
        print(f"\n{dataset['name']}:")
        success = fetch_kyoto_data(
            dataset['query'],
            dataset['file'],
            dataset['name']
        )

        if success:
            with open(dataset['file'], 'r') as f:
                data = json.load(f)
                total_features += len(data.get('features', []))

        time.sleep(2)  # API rate limiting

    print("\n" + "="*60)
    print(f" ✓ Complete: {total_features} POI features fetched")
    print("="*60)

if __name__ == '__main__':
    main()