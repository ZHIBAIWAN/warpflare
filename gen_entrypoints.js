const os = require("os")
const fs = require("fs")
const util = require("util")
const child_process = require("child_process")
const MMDBReader = require('mmdb-reader')
const { v4: uuid } = require("uuid")

const exec = util.promisify(child_process.exec)
const readFile = util.promisify(fs.readFile)

const archAffix = () => {
  const arch = os.arch()
  switch (arch) {
    case "ia32":
      return "386"
    case "x64":
      return "amd64"
    case "arm64":
      return "arm64"
    case "s390x":
      return "s390x"
    default:
      console.error("Unsupported CPU Architecture!")
      process.exit(1)
  }
}

const countryCodeToEmoji = countryCode => {
  if (!countryCode || countryCode.length != 2) {
    return '🌏'
  }

  const OFFSET = 127397
  const firstLetter = String.fromCodePoint(
    countryCode.toUpperCase().charCodeAt(0) + OFFSET)
  const secondLetter = String.fromCodePoint(
    countryCode.toUpperCase().charCodeAt(1) + OFFSET)

  return firstLetter + secondLetter
}

const usedName = []

const randomColorName = () => {
  const colors = ['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Indigo', 'Violet', 'Pink', 'Purple', 'Brown', 'Black', 'White', 'Gray'];
  const randomIndex = Math.floor(Math.random() * colors.length);
  return colors[randomIndex];
}

const usCities = ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'San Jose'];

const randomUSCity = () => {
  const randomIndex = Math.floor(Math.random() * usCities.length);
  return usCities[randomIndex];
}

const generateUniqueName = (countryEmoji, country, nameType = 'color', cnt = 0) => {
  let name

  if (nameType == 'color') {
    name = `${countryEmoji} ${country}-CF-${randomColorName()}`
    if (cnt > 100) {
      return generateUniqueName(countryEmoji, country, 'alternate', 0)
    }
  } else if (nameType == 'alternate') {
    name = `${countryEmoji} ${country}-CF-${randomUSCity()}`
    if (cnt > 100) {
      return generateUniqueName(countryEmoji, country, 'random', 0)
    }
  } else {
    name = `${countryEmoji} ${country}-CF-${uuid()}`
  }

  if (!usedName.includes(name)) {
    usedName.push(name)
    return name
  }
  return generateUniqueName(countryEmoji, country, nameType, cnt + 1)
}

const ensureMmdb = async () => {
  const cwd = process.cwd()
  const mmdbPath = `${cwd}/scripts/geolite/GeoLite2-Country.mmdb`

  if (!fs.existsSync(mmdbPath)) {
    console.log("MMDB file not found, downloading...")
    await exec(`wget -q "https://gitlab.com/P3TERX/GeoLite.mmdb/-/raw/download/GeoLite2-Country.mmdb" -O "${mmdbPath}"`)
    return
  }

  const header = fs.readFileSync(mmdbPath, {encoding: 'utf8', flag: 'r'}).slice(0, 100)
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
  const lines = csvData.filter(([_ip, _loss, delay]) => delay != 'timeout ms')
    .sort(([_ipA, lossA, delayA], [_ipB, lossB, delayB]) =>
      parseInt(lossA) == parseInt(lossB) ?
        parseInt(delayA) - parseInt(delayB) :
        parseInt(lossA) - parseInt(lossB))

  let reader
  try {
    reader = new MMDBReader(`${cwd}/scripts/geolite/GeoLite2-Country.mmdb`)
  } catch (e) {
    console.log("MMDB load failed, downloading fresh copy...")
    await exec(`wget -q "https://gitlab.com/P3TERX/GeoLite.mmdb/-/raw/download/GeoLite2-Country.mmdb" -O "${cwd}/scripts/geolite/GeoLite2-Country.mmdb"`)
    reader = new MMDBReader(`${cwd}/scripts/geolite/GeoLite2-Country.mmdb`)
  }

  const result = Array.from(new Set(lines.map(JSON.stringify)))
    .map(JSON.parse).slice(0, 11)
    .map(([ip, loss, delay]) => {
      let isoCode
      try {
        const geoData = reader.lookup(ip.split(":")[0])
        isoCode = geoData?.country?.is_code ??
          geoData?.registered_country?.iso_code ?? undefined
      } catch (e) {
        isoCode = undefined
      }
      const emoji = countryCodeToEmoji(isoCode)
      const name = isoCode ? `${emoji} ${isoCode}` : `${emoji} Unknown`
      const uniqueName = generateUniqueName(emoji, isoCode || 'UN')
      return `("${ip}", "${loss}", "${delay}", "${name}", "${uniqueName}")`
    })
  fs.writeFileSync(`${cwd}/ip.sql`, `BEGIN TRANSACTION;

DELETE FROM IP;

INSERT INTO IP (address, loss, delay, name, unique_name)
VALUES
\t${result.join(",\n\t")};

COMMIT;`)
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
  const iplist = 100
  const ipBase = [
    "162.159.192.", "162.159.193.", "162.159.195.", "162.159.204.",
    "188.114.96.", "188.114.97.", "188.114.98.", "188.114.99.",
  ]

  const temp = Array.from(
    { length: iplist },
    () => ipBase
      .map((base) =>
        `${base}${Math.floor(Math.random() * 256)}`))
    .flat()

  const uniqueIPs = Array.from(new Set(temp))
  const cwd = process.cwd()
  fs.writeFileSync(`${cwd}/ip.txt`, uniqueIPs.join('\n'))
}

;(() => {
  generateRandomIPs()
  Promise.all([endpointyx()])
})()