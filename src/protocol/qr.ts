/**
 * 零依赖二维码编码器：byte 模式（UTF-8）、纠错等级 M、版本 1–10，按 ISO/IEC 18004 生成模块矩阵并渲染内联 SVG。
 * 仓库不引第三方依赖，页面只负责显示、不负责生成，所以码字构造与图形渲染都在这里自己实现。
 * @module dsh-connect-raccoon/protocol/qr
 */

/** 二维码矩阵；`modules[row][col]` 为 `true` 表示深色模块。 */
export interface QrMatrix {
  /** 边长（模块数），等于 `version * 4 + 17`。 */
  size: number;
  /** 行优先的模块矩阵。 */
  modules: boolean[][];
}

/** `renderQrSvg` 的选项。 */
export interface QrSvgOptions {
  /** 输出 SVG 的像素边长，默认 220（设置卡片里二维码的显示宽度）。 */
  size?: number;
}

/** 内部矩阵：附带功能图案占位表，数据位不得写入这些模块。 */
interface WorkingMatrix extends QrMatrix {
  reserved: boolean[][];
}

/** 纠错块分组：[块数, 每块数据码字数, 每块 EC 码字数]。 */
type BlockGroup = readonly [count: number, dataCodewords: number, ecCodewords: number];

const MAX_VERSION = 10;

/** 版本 1–10、纠错等级 M 的分块表（ISO/IEC 18004 表 9）。 */
const BLOCKS_M: readonly (readonly BlockGroup[])[] = [
  [[1, 16, 10]],
  [[1, 28, 16]],
  [[1, 44, 26]],
  [[2, 32, 18]],
  [[2, 43, 24]],
  [[4, 27, 16]],
  [[4, 31, 18]],
  [[2, 38, 22], [2, 39, 22]],
  [[3, 36, 22], [2, 37, 22]],
  [[4, 43, 26], [1, 44, 26]],
];

/** 版本 1–10 的对齐图案中心坐标（ISO/IEC 18004 表 E.1）；版本 1 没有对齐图案。 */
const ALIGNMENT_CENTERS: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const UTF8 = new TextEncoder();

/** 编码为模块矩阵；内容超出 byte 模式 + 等级 M 的版本 1–10 容量时抛 {@link RangeError}。 */
export function encodeQrMatrix(content: string): QrMatrix {
  const bytes = UTF8.encode(content);
  const version = pickVersion(bytes.length);
  const codewords = interleaveCodewords(buildDataCodewords(bytes, version), version);
  const matrix = createWorkingMatrix(version);
  drawFunctionPatterns(matrix, version);
  placeCodewords(matrix, codewords);
  const mask = chooseMask(matrix);
  applyMask(matrix, mask);
  drawFormatBits(matrix, mask);
  return { size: matrix.size, modules: matrix.modules };
}

/** 渲染为可直接内联进 HTML 的完整 SVG；深色模块合成一条 path，四周留 4 模块静区。 */
export function renderQrSvg(content: string, options: QrSvgOptions = {}): string {
  const { size: moduleCount, modules } = encodeQrMatrix(content);
  const quietZone = 4;
  const extent = moduleCount + quietZone * 2;
  const pixelSize = options.size ?? 220;
  if (!Number.isFinite(pixelSize) || pixelSize <= 0) {
    throw new RangeError(`SVG 边长必须是正数：${pixelSize}`);
  }
  let path = '';
  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (modules[row]?.[col] === true) path += `M${col + quietZone} ${row + quietZone}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${extent} ${extent}" ` +
    `width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges">` +
    `<rect width="${extent}" height="${extent}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/></svg>`
  );
}

/** 选容量足够的最小版本；超容量抛错，不静默截断（截断会产出扫得开但内容错的码）。 */
function pickVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    if (byteLength <= byteCapacity(version)) return version;
  }
  throw new RangeError(
    `二维码内容 ${byteLength} 字节，超出 byte 模式 + 纠错等级 M 的版本 1–10 上限 ${byteCapacity(MAX_VERSION)} 字节`,
  );
}

/** 该版本在等级 M 下的数据码字总数。 */
function dataCodewordCount(version: number): number {
  const groups = BLOCKS_M[version - 1] ?? [];
  let total = 0;
  for (const [count, dataCodewords] of groups) total += count * dataCodewords;
  return total;
}

/** 字符计数指示符的位宽：版本 1–9 为 8 bit，版本 10 起为 16 bit。 */
function countBits(version: number): number {
  return version < 10 ? 8 : 16;
}

/** 该版本可容纳的 UTF-8 字节数：数据码字去掉模式指示符与字符计数。 */
function byteCapacity(version: number): number {
  return Math.floor((dataCodewordCount(version) * 8 - 4 - countBits(version)) / 8);
}

/** 拼出模式指示符 → 字符计数 → 数据 → 终止符 → 填充字节的完整数据码字。 */
function buildDataCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const capacityBits = dataCodewordCount(version) * 8;
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, countBits(version));
  for (const byte of bytes) appendBits(bits, byte, 8);

  // 终止符最多 4 个 0 位；数据已填满时一个也不写
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  // 先补 0 到字节边界，再按 0xEC / 0x11 交替填满剩余码字
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  let pad = 0xEC;
  while (bits.length < capacityBits) {
    appendBits(bits, pad, 8);
    pad = pad === 0xEC ? 0x11 : 0xEC;
  }

  const codewords = new Uint8Array(dataCodewordCount(version));
  for (let i = 0; i < capacityBits; i += 1) {
    if (bits[i] === 1) codewords[i >> 3] = codewords[i >> 3]! | (1 << (7 - (i & 7)));
  }
  return codewords;
}

/** 按高位在前的顺序追加 `length` 个比特。 */
function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

/** 分块、算 EC，再按「数据逐列、EC 逐列」交织成最终码字序列。 */
function interleaveCodewords(dataCodewords: Uint8Array, version: number): Uint8Array {
  const groups = BLOCKS_M[version - 1] ?? [];
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [count, dataLength, ecLength] of groups) {
    for (let i = 0; i < count; i += 1) {
      const block = dataCodewords.subarray(offset, offset + dataLength);
      offset += dataLength;
      dataBlocks.push(block);
      ecBlocks.push(reedSolomonRemainder(block, ecLength));
    }
  }

  const total = dataCodewords.length + ecBlocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  const maxData = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) if (i < block.length) out[cursor++] = block[i]!;
  }
  const maxEc = Math.max(...ecBlocks.map((block) => block.length));
  for (let i = 0; i < maxEc; i += 1) {
    for (const block of ecBlocks) if (i < block.length) out[cursor++] = block[i]!;
  }
  return out;
}

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

// GF(256) 乘法转成查表加法；表与 0x11D 本原多项式绑定，模块加载时建一次
for (let i = 0, value = 1; i < 255; i += 1) {
  GF_EXP[i] = value;
  GF_LOG[value] = i;
  value <<= 1;
  if (value & 0x100) value ^= 0x11D;
}
for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]!;

/** GF(256) 乘法。 */
function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** 计算 `(x - α^0)(x - α^1)…(x - α^(degree-1))` 的系数，省略首项 1。 */
function reedSolomonDivisor(degree: number): Uint8Array {
  const divisor = new Uint8Array(degree);
  divisor[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      const scaled = gfMul(divisor[j]!, root);
      // 复合赋值在 `noUncheckedIndexedAccess` 下读的是 `T | undefined`，这里显式取值。
      divisor[j] = scaled ^ (j + 1 < degree ? divisor[j + 1]! : 0);
    }
    root = gfMul(root, 0x02);
  }
  return divisor;
}

/** 对一块数据码字做多项式长除，返回长度等于纠错码字数的余式。 */
function reedSolomonRemainder(data: Uint8Array, ecLength: number): Uint8Array {
  const divisor = reedSolomonDivisor(ecLength);
  const remainder = new Uint8Array(ecLength);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.copyWithin(0, 1);
    remainder[ecLength - 1] = 0;
    for (let i = 0; i < ecLength; i += 1) remainder[i] = (remainder[i] ?? 0) ^ gfMul(divisor[i]!, factor);
  }
  return remainder;
}

function createWorkingMatrix(version: number): WorkingMatrix {
  const size = version * 4 + 17;
  return {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

/** 画定位、时序、对齐、格式与（v≥7 的）版本信息，并把它们标记为不可写数据。 */
function drawFunctionPatterns(matrix: WorkingMatrix, version: number): void {
  const size = matrix.size;
  for (const [centerX, centerY] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    drawFinderPattern(matrix, centerX, centerY);
  }
  // 时序图案只在两枚定位图案之间（含分隔符外的第 8 模块起），否则会抹掉定位图案与分隔符
  for (let i = 8; i < size - 8; i += 1) {
    setFunctionModule(matrix, 6, i, i % 2 === 0);
    setFunctionModule(matrix, i, 6, i % 2 === 0);
  }
  const centers = ALIGNMENT_CENTERS[version - 1] ?? [];
  for (const centerY of centers) {
    for (const centerX of centers) {
      // 三个定位图案的角上不画对齐图案
      if (isFinderCorner(centerX, centerY, size)) continue;
      // 对齐图案压过时序图案（v7 起位于第 6 行/列的那几个）
      drawAlignmentPattern(matrix, centerX, centerY);
    }
  }
  // 先以掩码 0 占位，数据位写入时会跳过这些模块；选定掩码后重画
  drawFormatBits(matrix, 0);
  if (version >= 7) drawVersionBits(matrix, version);
}

function isFinderCorner(centerX: number, centerY: number, size: number): boolean {
  return (
    (centerX === 6 && centerY === 6) ||
    (centerX === 6 && centerY === size - 7) ||
    (centerX === size - 7 && centerY === 6)
  );
}

/** 7×7 定位图案连同外侧一圈分隔符（距离 2 为浅色，0/1/3/4 为深色）。 */
function drawFinderPattern(matrix: WorkingMatrix, centerX: number, centerY: number): void {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunctionModule(matrix, centerX + dx, centerY + dy, distance !== 2 && distance !== 4);
    }
  }
}

/** 5×5 对齐图案：中心深色，距离 1 的环浅色，距离 2 的环深色。 */
function drawAlignmentPattern(matrix: WorkingMatrix, centerX: number, centerY: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      setFunctionModule(matrix, centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/** 写两份 15 bit 格式信息（等级 M 指示符 00 + 3 bit 掩码号，BCH(15,5) 后异或 0x5412）。 */
function drawFormatBits(matrix: WorkingMatrix, mask: number): void {
  const data = mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;

  // 第一份沿左上定位图案的两条边；第 6 位被时序图案占用，所以跨过它接续
  for (let i = 0; i <= 5; i += 1) setFunctionModule(matrix, 8, i, bitOf(bits, i));
  setFunctionModule(matrix, 8, 7, bitOf(bits, 6));
  setFunctionModule(matrix, 8, 8, bitOf(bits, 7));
  setFunctionModule(matrix, 7, 8, bitOf(bits, 8));
  for (let i = 9; i < 15; i += 1) setFunctionModule(matrix, 14 - i, 8, bitOf(bits, i));

  // 第二份拆成右上角横向 8 bit 与左下角纵向 7 bit；右下角固定深色模块单独画
  for (let i = 0; i < 8; i += 1) setFunctionModule(matrix, matrix.size - 1 - i, 8, bitOf(bits, i));
  for (let i = 8; i < 15; i += 1) setFunctionModule(matrix, 8, matrix.size - 15 + i, bitOf(bits, i));
  setFunctionModule(matrix, 8, matrix.size - 8, true);
}

/** 版本 7 起写两份 18 bit 版本信息：6 bit 版本号 + BCH(18,6) 校验，生成多项式 0x1F25。 */
function drawVersionBits(matrix: WorkingMatrix, version: number): void {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1F25);
  const bits = (version << 12) | remainder;
  for (let i = 0; i < 18; i += 1) {
    const dark = bitOf(bits, i);
    const a = matrix.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunctionModule(matrix, a, b, dark);
    setFunctionModule(matrix, b, a, dark);
  }
}

function setFunctionModule(matrix: WorkingMatrix, col: number, row: number, dark: boolean): void {
  if (row < 0 || row >= matrix.size || col < 0 || col >= matrix.size) return;
  matrix.modules[row]![col] = dark;
  matrix.reserved[row]![col] = true;
}

function bitOf(value: number, index: number): boolean {
  return ((value >>> index) & 1) === 1;
}

/** 从右下角起，按 2 列宽的蛇形路径填充码字，跳过功能图案并跳过第 6 列（纵向时序）。 */
function placeCodewords(matrix: WorkingMatrix, codewords: Uint8Array): void {
  const size = matrix.size;
  const bitLimit = codewords.length * 8;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vertical = 0; vertical < size; vertical += 1) {
      const row = upward ? size - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const col = right - offset;
        if (matrix.reserved[row]?.[col] === true || bitIndex >= bitLimit) continue;
        const byte = codewords[bitIndex >>> 3]!;
        matrix.modules[row]![col] = bitOf(byte, 7 - (bitIndex & 7));
        bitIndex += 1;
      }
    }
  }
}

/** 依次试 8 种掩码，罚分最低者胜出（掩码自逆，试完再异或一次即还原）。 */
function chooseMask(matrix: WorkingMatrix): number {
  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(matrix, mask);
    drawFormatBits(matrix, mask);
    const penalty = penaltyScore(matrix);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    applyMask(matrix, mask);
  }
  return bestMask;
}

function applyMask(matrix: WorkingMatrix, mask: number): void {
  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (matrix.reserved[row]?.[col] === true) continue;
      if (isMasked(mask, row, col)) matrix.modules[row]![col] = matrix.modules[row]![col] !== true;
    }
  }
}

/** ISO/IEC 18004 表 10 的 8 种掩码条件；`row` 是 i，`col` 是 j。 */
function isMasked(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

/** 按 ISO/IEC 18004 的四个罚分规则给整幅矩阵打分。 */
function penaltyScore(matrix: WorkingMatrix): number {
  const size = matrix.size;
  const modules = matrix.modules;
  let score = 0;

  // 规则 1（同色连续段）与规则 3（类定位图案）都按「逐行/逐列扫一遍连续段」计算
  for (let row = 0; row < size; row += 1) {
    const line = Array.from({ length: size }, (_, col) => modules[row]?.[col] === true);
    score += runPenalty(line) + finderLikePenalty(line, size);
  }
  for (let col = 0; col < size; col += 1) {
    const line = Array.from({ length: size }, (_, row) => modules[row]?.[col] === true);
    score += runPenalty(line) + finderLikePenalty(line, size);
  }

  // 规则 2：2×2 同色块，每块罚 3
  for (let row = 0; row + 1 < size; row += 1) {
    for (let col = 0; col + 1 < size; col += 1) {
      const color = modules[row]?.[col] === true;
      if (
        color === (modules[row]?.[col + 1] === true) &&
        color === (modules[row + 1]?.[col] === true) &&
        color === (modules[row + 1]?.[col + 1] === true)
      ) {
        score += 3;
      }
    }
  }

  // 规则 4：深色比例每偏离 50% 满 5% 罚 10
  let darkModules = 0;
  for (const row of modules) {
    for (const dark of row) if (dark) darkModules += 1;
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(darkModules * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** 规则 1：每条同色连续段长度 `n ≥ 5` 罚 `3 + (n - 5)`。 */
function runPenalty(line: readonly boolean[]): number {
  let score = 0;
  let run = 1;
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === line[i - 1]) {
      run += 1;
    } else {
      if (run >= 5) score += 3 + (run - 5);
      run = 1;
    }
  }
  if (run >= 5) score += 3 + (run - 5);
  return score;
}

/**
 * 规则 3：`n:n:3n:n:n` 的类定位图案每处罚 40。
 * 比例按段长等比缩放（不限于 1 模块宽），且图案某一侧要有 4n 宽的浅色区；
 * 因此用「最近 7 段长度」的滑动窗口判断，窗口外按浅色边界补齐。
 */
function finderLikePenalty(line: readonly boolean[], size: number): number {
  const history = [0, 0, 0, 0, 0, 0, 0];
  let score = 0;
  let runColor = false;
  let run = 0;

  const pushHistory = (length: number): void => {
    // 起始浅色段要加上图案外侧的整条静区（扫描范围之外按浅色处理）
    const extended = history[0] === 0 ? length + size : length;
    history.pop();
    history.unshift(extended);
  };
  const countPatterns = (): number => {
    const n = history[1] ?? 0;
    const core =
      n > 0 &&
      history[2] === n &&
      history[3] === n * 3 &&
      history[4] === n &&
      history[5] === n;
    if (!core) return 0;
    return (
      (history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) +
      (history[6]! >= n * 4 && history[0]! >= n ? 1 : 0)
    );
  };

  for (const dark of line) {
    if (dark === runColor) {
      run += 1;
    } else {
      pushHistory(run);
      // 只在浅色段结束时判一次，避免同一个图案被两侧各计一遍
      if (!runColor) score += countPatterns() * 40;
      runColor = dark;
      run = 1;
    }
  }
  if (runColor) {
    pushHistory(run);
    run = 0;
  }
  pushHistory(run + size);
  score += countPatterns() * 40;
  return score;
}
