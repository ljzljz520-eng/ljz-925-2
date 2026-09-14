/** 生成示例"摄影作品" SVG (实际使用时把真实照片放进 photos/ 并在 photos 表登记即可) */
const fs = require('fs');
const path = require('path');

const PHOTOS = [
  { title: '山间晨雾',   c: ['#1a2a4a', '#4a6fa5', '#c8d8e8'], sun: '#f5e6c8' },
  { title: '暮色海岸',   c: ['#2b1055', '#7597de', '#ff9a8b'], sun: '#ffd3a5' },
  { title: '雪原孤树',   c: ['#8e9eab', '#eef2f3', '#dfe9f3'], sun: '#ffffff' },
  { title: '沙漠落日',   c: ['#3e1f0d', '#c96f2f', '#f7c873'], sun: '#ffdf8e' },
  { title: '森林光斑',   c: ['#0f2a1d', '#2d6a4f', '#95d5b2'], sun: '#d8f3dc' },
  { title: '城市夜色',   c: ['#0b0c2a', '#252a5e', '#5e60ce'], sun: '#64dfdf' },
  { title: '秋日湖畔',   c: ['#432818', '#99582a', '#ffe6a7'], sun: '#ffedd8' },
  { title: '星空旷野',   c: ['#03045e', '#023e8a', '#0077b6'], sun: '#caf0f8' },
];

function svg(p, i) {
  const [c1, c2, c3] = p.c;
  const stars = i === 7 ? Array.from({length: 60}, () => {
    const x = Math.random() * 800, y = Math.random() * 300, r = Math.random() * 1.5 + 0.3;
    return `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(1)}" fill="#fff" opacity="${(Math.random()*0.7+0.3).toFixed(2)}"/>`;
  }).join('') : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="0.6" stop-color="${c2}"/><stop offset="1" stop-color="${c3}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${p.sun}" stop-opacity="0.9"/><stop offset="1" stop-color="${p.sun}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="800" height="1000" fill="url(#sky)"/>
  ${stars}
  <circle cx="${560 - i * 60}" cy="${300 + (i % 3) * 60}" r="160" fill="url(#glow)"/>
  <circle cx="${560 - i * 60}" cy="${300 + (i % 3) * 60}" r="46" fill="${p.sun}"/>
  <path d="M0 ${620 + i * 20} L200 ${460 + i * 15} L380 ${600 + i * 10} L560 ${480 + i * 18} L800 ${640 - i * 8} V1000 H0 Z" fill="${c1}" opacity="0.85"/>
  <path d="M0 ${760 - i * 10} L260 ${600 + i * 12} L520 ${740 - i * 6} L800 ${620 + i * 14} V1000 H0 Z" fill="${c1}" opacity="0.6"/>
  <rect y="820" width="800" height="180" fill="${c1}" opacity="0.9"/>
  <text x="60" y="920" font-family="Georgia, serif" font-size="44" fill="${p.sun}" opacity="0.9">${p.title}</text>
  <text x="60" y="960" font-family="Georgia, serif" font-size="18" fill="${c3}" opacity="0.7">SERIES No.${String(i + 1).padStart(2, '0')} · 2026</text>
</svg>`;
}

const dir = path.join(__dirname, 'photos');
PHOTOS.forEach((p, i) => {
  fs.writeFileSync(path.join(dir, `photo-${i + 1}.svg`), svg(p, i));
});
console.log('generated', PHOTOS.length, 'photos');
