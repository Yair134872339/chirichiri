#!/usr/bin/env python3
"""
Fetch PLATEAU data from MLIT (Ministry of Land, Infrastructure, Transport and Tourism)
"""
import json
import glob
import os
import requests

def download_plateau_data():
    """Download PLATEAU data for Kyoto City"""
    print("="*60)
    print(" PLATEAU Data Fetch - Kyoto City")
    print("="*60)

    os.makedirs('data/kyoto/plateau', exist_ok=True)

    # PLATEAU data URL (2024 version)
    base_url = "https://assets.cms.plateau.reearth.io/assets"

    datasets = {
        'related': {
            'url': f"{base_url}/0e/bfa87f-7251-4c71-8861-452715ea3b97/26100_kyoto-shi_2024_related.zip",
            'name': '京都市関連データ（避難所・ランドマーク等）'
        }
    }

    for key, config in datasets.items():
        print(f"\n{config['name']}:")
        output_file = f"data/kyoto/plateau/{key}.zip"

        # Check if already extracted
        if os.path.exists(output_file.replace('.zip', '')):
            print(f"  ✓ Already extracted")
            continue

        try:
            print(f"  Downloading...")
            response = requests.get(config['url'], stream=True, timeout=60)

            if response.status_code == 200:
                with open(output_file, 'wb') as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        f.write(chunk)
                print(f"  ✓ Download complete: {output_file}")

                # Extract ZIP
                import zipfile
                with zipfile.ZipFile(output_file, 'r') as zip_ref:
                    extract_dir = output_file.replace('.zip', '')
                    zip_ref.extractall(extract_dir)
                    print(f"  ✓ Extracted: {extract_dir}")

                os.remove(output_file)
            else:
                print(f"  ✗ Error: HTTP {response.status_code}")
        except Exception as e:
            print(f"  ✗ Error: {e}")

def organize_plateau_data():
    """Organize and merge PLATEAU data by category"""
    print("\n[Data Organization]")

    categories = {
        'shelters': {
            'pattern': '*_shelter.geojson',
            'output': 'data/kyoto/plateau/shelters.geojson',
            'name': '避難所'
        },
        'landmarks': {
            'pattern': '*_landmark.geojson',
            'output': 'data/kyoto/plateau/landmarks.geojson',
            'name': 'ランドマーク'
        },
        'parks': {
            'pattern': '*_park.geojson',
            'output': 'data/kyoto/plateau/parks.geojson',
            'name': '公園'
        },
        'emergency_routes': {
            'pattern': '*_emergency_route.geojson',
            'output': 'data/kyoto/plateau/emergency_routes.geojson',
            'name': '緊急輸送道路'
        }
    }

    for category, config in categories.items():
        all_features = []

        # Search related files
        files = glob.glob(f"data/kyoto/plateau/related/{config['pattern']}")

        for file in files:
            with open(file, 'r', encoding='utf-8') as f:
                data = json.load(f)
                features = data.get('features', [])

                # Standardize properties
                for feature in features:
                    props = feature.get('properties', {})
                    props['data_source'] = 'PLATEAU'
                    props['category'] = category

                    # Standardize name field
                    if '名称' in props and 'name' not in props:
                        props['name'] = props['名称']

                all_features.extend(features)

        if all_features:
            geojson = {
                'type': 'FeatureCollection',
                'features': all_features,
                'metadata': {
                    'source': 'PLATEAU',
                    'year': '2024',
                    'category': config['name'],
                    'count': len(all_features)
                }
            }

            with open(config['output'], 'w', encoding='utf-8') as f:
                json.dump(geojson, f, ensure_ascii=False, indent=2)

            print(f"  ✓ {config['name']}: {len(all_features)} features → {config['output']}")

def main():
    """Main process"""
    download_plateau_data()
    organize_plateau_data()

    print("\n" + "="*60)
    print(" ✓ PLATEAU data fetch and organization complete")
    print("="*60)

if __name__ == '__main__':
    main()