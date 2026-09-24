const fs = require('fs');
const crypto = require('crypto');

// Center point (e.g., downtown Cincinnati)
const CENTER_LAT = 39.0501;
const CENTER_LNG = -84.1915;
const RADIUS_MILES = 5;

// Helper to generate random coordinates within a radius
function getRandomLocation(centerLat, centerLng, radius) {
    const y0 = centerLat;
    const x0 = centerLng;
    const rd = radius / 69; // ~69 miles per degree
    const u = Math.random();
    const v = Math.random();
    const w = rd * Math.sqrt(u);
    const t = 2 * Math.PI * v;
    const x = w * Math.cos(t);
    const y = w * Math.sin(t);
    return { lat: y + y0, lng: x + x0 };
}

function generateMockData(numRecords) {
    const records = [];
    const types = ['utility_box', 'transit_stop', 'network_node', 'ar_anchor'];

    for (let i = 0; i < numRecords; i++) {
        const loc = getRandomLocation(CENTER_LAT, CENTER_LNG, RADIUS_MILES);
        records.push({
            id: `node_${crypto.randomUUID()}`,
            type: types[Math.floor(Math.random() * types.length)],
            coordinates: { lat: loc.lat, lng: loc.lng },
            verification_hash: crypto.createHash('sha256').update(Date.now().toString() + i).digest('hex'),
            trust_score: Math.floor(Math.random() * (100 - 60 + 1) + 60), // Score 60-100
            discovered_by: `user_${Math.floor(Math.random() * 50)}`, // 50 mock users
            timestamp: new Date(Date.now() - Math.floor(Math.random() * 10000000000)).toISOString()
        });
    }
    return records;
}

const mockData = generateMockData(500); // Generate 500 nodes for clustering tests
fs.writeFileSync('patchwork_mock_data.json', JSON.stringify(mockData, null, 2));
console.log('Mock data generated for UI clustering tests.');