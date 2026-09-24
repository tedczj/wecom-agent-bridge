import sharp from 'sharp';

/** Fixed synthetic pixels; neither filenames nor the request reveal the expected colors. */
export async function geometryImage(): Promise<Buffer> {
  const width = 192, height = 112, pixels = Buffer.alloc(width * height * 3, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const circle = (x - 48) ** 2 + (y - 56) ** 2 <= 30 ** 2;
    const square = x >= 112 && x < 172 && y >= 26 && y < 86;
    if (circle || square) { const offset = (y * width + x) * 3; pixels[offset] = circle ? 255 : 0; pixels[offset + 1] = 0; pixels[offset + 2] = square ? 255 : 0; }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** Automate only unambiguous descriptions; unrecognized prose is not a semantic PASS. */
export function geometryAnswer(first: string, second: string): 'matches' | 'uncertain' {
  const text = first.trim().replace(/^(?:[-*]|\d+[.)、])\s*/gm, '').replace(/\*\*/g, '').replace(/[\s，,。.;；、：:]/g, '')
    .replace(/^(?:图中有|图中是|这张图中有|这张图里有|分别是)(?:两个形状)?/, '').replace(/^图中(?=左|右)/, '');
  const red = '(?:左[边侧](?:是|为))?(?:一个)?红色(?:的)?圆(?:形)?', blue = '(?:右[边侧](?:是|为))?(?:一个)?蓝色(?:的)?(?:正方形|方形|方块)';
  const description = new RegExp(`^(?:${red}(?:和|与)?${blue}|${blue}(?:和|与)?${red})$`);
  return description.test(text) && /^(?:红|红色)[。.!！]?$/.test(second.trim()) ? 'matches' : 'uncertain';
}
