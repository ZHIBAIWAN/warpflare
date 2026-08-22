const os = require("os")
const fs = require("fs")
const util = require("util")
const child_process = require("child_process")
const MMDBReader = require('mmdb-reader')

const exec = util.promisify(child_process.exec)
const readFile = util.promisify(fs.readFile)

const archAffix = () => {
  const arch = os.arch()
  switch (arch) {
    case "ia32": return "386"
    case "x64": return "amd64"
    case "arm64": return "arm64"
    case "s390x": return "s390x"
    default:
      console.error("Unsupported CPU Architecture!")
      process.exit(1)
  }
}

const countryCN = {
  US: "美国", SG: "新加坡", JP: "日本", HK: "香港", TW: "台湾",
  KR: "韩国", GB: "英国", DE: "德国", FR: "法国", CA: "加拿大",
  AU: "澳大利亚", NL: "荷兰", SE: "瑞典", NO: "挪威", DK: "丹麦",
  FI: "芬兰", IT: "意大利", ES: "西班牙", PT: "葡萄牙", CH: "瑞士",
  AT: "奥地利", BE: "比利时", IE: "爱尔兰", NZ: "新西兰", RU: "俄罗斯",
  BR: "巴西", IN: "印度", AE: "阿联酋", ZA: "南非", MX: "墨西哥",
  AR: "阿根廷", IL: "以色列", TR: "土耳其", PL: "波兰", CZ: "捷克",
  HU: "匈牙利", RO: "罗马尼亚", UA: "乌克兰", GR: "希腊", EG: "埃及",
  TH: "泰国", VN: "越南", ID: "印度尼西亚", MY: "马来西亚", PH: "菲律宾",
  MO: "澳门", LU: "卢森堡", CL: "智利", CO: "哥伦比亚", PE: "秘鲁",
  NZ: "新西兰", ZA: "南非", NG: "尼日利亚", KE: "肯尼亚",
  IS: "冰岛", EE: "爱沙尼亚", LV: "拉脱维亚", LT: "立陶宛",
  SK: "斯洛伐克", SI: "斯洛文尼亚", HR: "克罗地亚", RS: "塞尔维亚",
  BG: "保加利亚", CY: "塞浦路斯", MT: "马耳他"
}

const countryCodeToEmoji = countryCode => {
  if (!countryCode || countryCode.length != 2) return '🌏'
  const OFFSET = 127397
  return String.fromCodePoint(
    countryCode.toUpperCase().charCodeAt(0) + OFFSET,
    countryCode.toUpperCase().charCodeAt(1) + OFFSET
  )
}

const ensureMmdb = async () => {
  const cwd = process.cwd()
  const mmdbPath = `${cwd}/scripts/geolite/GeoLite2-Country.mmdb`

  if (!fs.existsSync(mmdbPath)) {
    console.log("MMDB file not found, downloading...")
    await exec(`wget -q "https://gitlab.com/P3TERX/GeoLite.mmdb/-/raw/download/GeoLite2-Country.mmdb" -O "${mmdbPath}"`)
    return
  }

  const header = fs.readFileSync(mmdbPath, { encoding: 'utf8', flag: 'r' }).slice(0, 100)
  if (header.includes('git-lfs') || header.includes('version https')) {
    console.log("MMDB file is a Git LFS pointer, downloading real file...")
    await exec(`wget -q "https://gitlab.com/P3TERX/GeoLite.mmdb/-/raw/download/GeoLite2-Country.mmdb" -O "${mmdbPath}"`)
  } else {
    console.log("MMDB file is valid")
  }
}

const processCsv = async () => {
  const cwd = process.cwd()
  const data = await readFile(`${cwd}/result.csv`, 'utf8')
  const rows = data.split('\n')
  const csvData = rows.map(row => row.split(','))
  csvData.shift()

  const lines = csvData
    .filter(([_ip, _loss, delay]) => delay != 'timeout ms')
    .sort(([_ipA, lossA, delayA], [_ipB, lossB, delayB]) =>
      parseInt(lossA) == parseInt(lossB)
        ? parseInt(delayA) - parseInt(delayB)
        : parseInt(lossA) - parseInt(lossB))

  let reader
  try {
    reader = new MMDBReader(`${cwd}/scripts/geolite/GeoLite2-Country.mmdb`)
  } catch (e) {
    console.log("MMDB load failed, downloading fresh copy...")
    await exec(`wget -q "https://gitlab.com/P3TERX/GeoLite.mmdb/-/raw/download/GeoLite2-Country.mmdb" -O "${cwd}/scripts/geolite/GeoLite2-Country.mmdb"`)
    reader = new MMDBReader(`${cwd}/scripts/geolite/GeoLite2-Country.mmdb`)
  }

  // Group by country, take best 3 from each country
  const countryGroups = {}
  const seen = new Set()

  for (const row of lines) {
    const [ip, loss, delay] = row
    const ipKey = ip.split(":")[0]
    if (seen.has(ipKey)) continue
    seen.add(ipKey)

    let isoCode
    try {
      const geoData = reader.lookup(ipKey)
      isoCode = geoData?.country?.is_code ??
        geoData?.registered_country?.iso_code ?? 'ZZ'
    } catch (e) {
      isoCode = 'ZZ'
    }

    if (!countryGroups[isoCode]) countryGroups[isoCode] = []
    if (countryGroups[isoCode].length < 3) {
      countryGroups[isoCode].push({ ip, loss, delay, isoCode })
    }
  }

  // Build result: first from all countries, then fill remaining with best from each
  let result = []
  const countries = Object.keys(countryGroups).sort()

  // Take first from each country
  for (const cc of countries) {
    if (countryGroups[cc].length > 0) {
      result.push(countryGroups[cc].shift())
    }
  }

  // Fill remaining slots with additional nodes, prioritizing countries with more nodes
  const MAX_NODES = 40
  while (result.length < MAX_NODES) {
    let added = false
    for (const cc of countries) {
      if (countryGroups[cc].length > 0) {
        result.push(countryGroups[cc].shift())
        added = true
        if (result.length >= MAX_NODES) break
      }
    }
    if (!added) break
  }

  // Track used names to avoid duplicates
  const nameCounts = {}

  const sqlRows = result.map(({ ip, loss, delay, isoCode }) => {
    const cnName = isoCode && isoCode !== 'ZZ'
      ? (countryCN[isoCode] || isoCode)
      : '未知'
    const emoji = countryCodeToEmoji(isoCode)
    nameCounts[cnName] = (nameCounts[cnName] || 0) + 1
    const seq = String(nameCounts[cnName]).padStart(2, '0')
    const uniqueName = `${emoji} ${cnName}-${seq}`
    const name = isoCode && isoCode !== 'ZZ' ? `${emoji} ${cnName}` : `${emoji} 未知`
    return `("${ip}", "${loss}", "${delay}", "${name}", "${uniqueName}")`
  })

  console.log(`\nFound ${result.length} nodes from ${countries.length} countries:`)
  const countryCounts = {}
  result.forEach(r => {
    const cc = r.isoCode
    countryCounts[cc] = (countryCounts[cc] || 0) + 1
  })
  for (const [cc, count] of Object.entries(countryCounts)) {
    const cn = countryCN[cc] || cc
    console.log(`  ${countryCodeToEmoji(cc)} ${cn}: ${count} nodes`)
  }
  console.log('')

  fs.writeFileSync(`${cwd}/ip.sql`, `DELETE FROM IP;

INSERT INTO IP (address, loss, delay, name, unique_name)
VALUES
\t${sqlRows.join(",\n\t")};`)
}

async function endpointyx() {
  try {
    const cwd = process.cwd()
    if (!fs.existsSync(`${cwd}/warp`)) {
      console.log("Unable to detect warp, currently downloading...")
      await exec(`wget https://gitlab.com/Misaka-blog/warp-script/-/raw/main/files/warp-yxip/warp-linux-${archAffix()} -O ${cwd}/warp`)
    }

    await exec(`chmod +x ${cwd}/warp`)
    try {
      await exec(`ulimit -n 102400 2>/dev/null; ${cwd}/warp`)
    } catch (e) {
      console.log("warp direct run failed, trying without ulimit...")
      await exec(`${cwd}/warp`)
    }
    await ensureMmdb()
    await processCsv()

    if (fs.existsSync(`${cwd}/ip.txt`)) fs.unlinkSync(`${cwd}/ip.txt`)
    if (fs.existsSync(`${cwd}/result.csv`)) fs.unlinkSync(`${cwd}/result.csv`)
    if (fs.existsSync(`${cwd}/warp`)) fs.unlinkSync(`${cwd}/warp`)
  } catch (error) {
    console.error("An error occurred:", error)
  }
}

const generateRandomIPs = () => {
  const targetCount = 800

  // Cloudflare WARP known IP ranges
  const ipBases = []
  // 162.159.192.x - 162.159.255.x (many subnets host WARP)
  for (let i = 192; i <= 255; i++) {
    ipBases.push(`162.159.${i}.`)
  }
  // 188.114.96.x - 188.114.111.x
  for (let i = 96; i <= 111; i++) {
    ipBases.push(`188.114.${i}.`)
  }
  // Additional known WARP ranges
  ipBases.push("162.158.0.", "162.158.1.", "162.158.2.", "162.158.3.")
  ipBases.push("162.158.4.", "162.158.5.", "162.158.6.", "162.158.7.")

  const temp = []
  // Generate random IPs from the full range
  for (let i = 0; i < targetCount; i++) {
    const base = ipBases[Math.floor(Math.random() * ipBases.length)]
    const last = Math.floor(Math.random() * 256)
    temp.push(`${base}${last}`)
  }

  const uniqueIPs = Array.from(new Set(temp))
  const cwd = process.cwd()
  fs.writeFileSync(`${cwd}/ip.txt`, uniqueIPs.join('\n'))
  console.log(`Generated ${uniqueIPs.length} unique IPs for scanning`)
}

;(() => {
  generateRandomIPs()
  Promise.all([endpointyx()])
})()