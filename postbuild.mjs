import * as fs from 'fs';
import * as path from 'path';

const distDir = './dist';
const files = fs.readdirSync(distDir);

for (const file of files) {
  if (file.endsWith('.js') && !file.includes('[')) {
    const newName = file.replace('.js', '-[hash].js');
    fs.renameSync(path.join(distDir, file), path.join(distDir, newName));
    console.log(`Renamed ${file} -> ${newName}`);
  }
}

console.log('Postbuild complete');
