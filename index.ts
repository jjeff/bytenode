import fs from 'fs'
import vm from 'vm'
import v8 from 'v8'
import path from 'path'
import { fork } from 'child_process'
import Module from 'module'

v8.setFlagsFromString('--no-lazy')

if (Number.parseInt(process.versions.node.split('.')[0], 10) >= 12) {
  v8.setFlagsFromString('--no-flush-bytecode') // Thanks to A-Parser (@a-parser)
}

const COMPILED_EXTNAME = '.jsc'

/**
 * Generates v8 bytecode buffer.
 * @param   {string} javascriptCode JavaScript source that will be compiled to bytecode.
 * @returns {Buffer} The generated bytecode.
 */
export const compileCode = function (javascriptCode: string): Buffer {
  if (typeof javascriptCode !== 'string') {
    throw new Error(`javascriptCode must be string. ${typeof javascriptCode} was given.`)
  }

  const script = new vm.Script(javascriptCode, {
    produceCachedData: true
  })

  const bytecodeBuffer = (script.createCachedData && script.createCachedData.call)
    ? script.createCachedData()
    // @ts-ignore
    : script.cachedData

  return bytecodeBuffer
}

/**
 * This function runs the compileCode() function (above)
 * via a child process usine Electron as Node
 * @param {string} javascriptCode
 * @returns {Promise<Buffer>} - returns a Promise which resolves in the generated bytecode.
 */
export const compileElectronCode = function (javascriptCode: string): Promise<Buffer> {
  // console.log('\nCompiling with Electron\n')
  return new Promise((resolve, reject) => {
    let data = Buffer.from([])

    const electronPath = path.join('node_modules', 'electron', 'cli.js')
    if (!fs.existsSync(electronPath)) {
      throw new Error('Electron not installed')
    }
    const bytenodePath = path.join(__dirname, 'cli.js')

    // create a subprocess in which we run Electron as our Node and V8 engine
    // running Bytenode to compile our code through stdin/stdout
    const proc = fork(electronPath, [bytenodePath, '--compile', '--no-module', '-'], {
      env: { ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    })

    if (proc.stdin) {
      proc.stdin.write(javascriptCode)
      proc.stdin.end()
    }

    if (proc.stdout) {
      proc.stdout.on('data', (chunk) => {
        data = Buffer.concat([data, chunk])
      })
      proc.stdout.on('error', (err) => {
        console.error(err)
      })
      proc.stdout.on('end', () => {
        resolve(data)
      })
    }

    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        console.error('Error: ', chunk)
      })
      proc.stderr.on('error', (err) => {
        console.error('Error: ', err)
      })
    }

    proc.addListener('message', (message) => console.log(message))
    proc.addListener('error', err => console.error(err))

    proc.on('error', (err) => reject(err))
    proc.on('exit', () => { resolve(data) })
  })
}

// TODO: rewrite this function
const fixBytecode = function (bytecodeBuffer: Buffer) {
  if (!Buffer.isBuffer(bytecodeBuffer)) {
    throw new Error('bytecodeBuffer must be a buffer object.')
  }

  const dummyBytecode = compileCode('"ಠ_ಠ"')

  if (process.version.startsWith('v8.8') || process.version.startsWith('v8.9')) {
    // Node is v8.8.x or v8.9.x
    dummyBytecode.slice(16, 20).copy(bytecodeBuffer, 16)
    dummyBytecode.slice(20, 24).copy(bytecodeBuffer, 20)
  } else if (process.version.startsWith('v12') ||
    process.version.startsWith('v13') ||
    process.version.startsWith('v14') ||
    process.version.startsWith('v15')) {
    dummyBytecode.slice(12, 16).copy(bytecodeBuffer, 12)
  } else {
    dummyBytecode.slice(12, 16).copy(bytecodeBuffer, 12)
    dummyBytecode.slice(16, 20).copy(bytecodeBuffer, 16)
  }
}

// TODO: rewrite this function
const readSourceHash = function (bytecodeBuffer: Buffer) {
  if (!Buffer.isBuffer(bytecodeBuffer)) {
    throw new Error('bytecodeBuffer must be a buffer object.')
  }

  if (process.version.startsWith('v8.8') || process.version.startsWith('v8.9')) {
    // Node is v8.8.x or v8.9.x
    // eslint-disable-next-line no-return-assign
    return bytecodeBuffer.slice(12, 16).reduce((sum, number, power) => sum += number * Math.pow(256, power), 0)
  } else {
    // eslint-disable-next-line no-return-assign
    return bytecodeBuffer.slice(8, 12).reduce((sum, number, power) => sum += number * Math.pow(256, power), 0)
  }
}

/**
 * Runs v8 bytecode buffer and returns the result.
 * @param   {Buffer} bytecodeBuffer The buffer object that was created using compileCode function.
 * @returns {any}    The result of the very last statement executed in the script.
 */
export const runBytecode = function (bytecodeBuffer: Buffer): any {
  if (!Buffer.isBuffer(bytecodeBuffer)) {
    throw new Error('bytecodeBuffer must be a buffer object.')
  }

  fixBytecode(bytecodeBuffer)

  const length = readSourceHash(bytecodeBuffer)

  let dummyCode = ''

  if (length > 1) {
    dummyCode = '"' + '\u200b'.repeat(length - 2) + '"' // "\u200b" Zero width space
  }

  const script = new vm.Script(dummyCode, {
    cachedData: bytecodeBuffer
  })

  if (script.cachedDataRejected) {
    throw new Error('Invalid or incompatible cached data (cachedDataRejected)')
  }

  return script.runInThisContext()
}

interface BytenodeOptions {
  filename: string
  output?: string
  compileAsModule?: boolean
  electron?: boolean
  createLoader?: boolean
  loaderFilename?: string
}

/**
 * Compiles JavaScript file to .jsc file.
 * @param   {object|string} args
 * @param   {string}          args.filename The JavaScript source file that will be compiled
 * @param   {boolean}         [args.compileAsModule=true] If true, the output will be a commonjs module
 * @param   {string}          [args.output=filename.jsc] The output filename. Defaults to the same path and name of the original file, but with `.jsc` extension.
 * @param   {boolean}         [args.electron=false] If true, compile code for Electron (which needs to be installed)
 * @param   {boolean}         [args.createLoader=false] If true, create a loader file.
 * @param   {boolean}         [args.loaderFilename='%.loader.js'] Filename or pattern for generated loader files. Defaults to originalFilename.loader.js. Use % as a substitute for originalFilename.
 * @param   {string}        [output] The output filename. (Deprecated: use args.output instead)
 * @returns {Promise<string>}        A Promise which returns the compiled filename
 */
export const compileFile = async function (args: BytenodeOptions | string, output?: string) {
  let filename, compileAsModule, electron, createLoader, loaderFilename

  if (typeof args === 'string') {
    filename = args
    compileAsModule = true
    electron = false
    createLoader = false
  } else if (typeof args === 'object') {
    filename = args.filename
    compileAsModule = args.compileAsModule !== false
    electron = args.electron
    createLoader = true
    loaderFilename = args.loaderFilename
    if (loaderFilename) createLoader = true
  }

  if (typeof filename !== 'string') {
    throw new Error(`filename must be a string. ${typeof filename} was given.`)
  }

  // @ts-ignore
  const compiledFilename = args.output || output || filename.slice(0, -3) + COMPILED_EXTNAME

  if (typeof compiledFilename !== 'string') {
    throw new Error(`output must be a string. ${typeof compiledFilename} was given.`)
  }

  const javascriptCode = fs.readFileSync(filename, 'utf-8')

  let code

  if (compileAsModule) {
    code = Module.wrap(javascriptCode.replace(/^#!.*/, ''))
  } else {
    code = javascriptCode.replace(/^#!.*/, '')
  }

  let bytecodeBuffer

  if (electron) {
    bytecodeBuffer = await compileElectronCode(code)
  } else {
    bytecodeBuffer = compileCode(code)
  }

  fs.writeFileSync(compiledFilename, bytecodeBuffer)

  if (createLoader) {
    addLoaderFile(compiledFilename, loaderFilename)
  }

  return compiledFilename
}

/**
 * Runs .jsc file and returns the result.
 * @param   {string} filename
 * @returns {any}    The result of the very last statement executed in the script.
 */
export const runBytecodeFile = function (filename: string) {
  if (typeof filename !== 'string') {
    throw new Error(`filename must be a string. ${typeof filename} was given.`)
  }

  const bytecodeBuffer = fs.readFileSync(filename)

  return runBytecode(bytecodeBuffer)
}

// @ts-ignore
Module._extensions[COMPILED_EXTNAME] = function (module: Module, filename: string) {
  const bytecodeBuffer = fs.readFileSync(filename)

  fixBytecode(bytecodeBuffer)

  const length = readSourceHash(bytecodeBuffer)

  let dummyCode = ''

  if (length > 1) {
    dummyCode = '"' + '\u200b'.repeat(length - 2) + '"' // "\u200b" Zero width space
  }

  const script = new vm.Script(dummyCode, {
    filename: filename,
    lineOffset: 0,
    displayErrors: true,
    cachedData: bytecodeBuffer
  })

  if (script.cachedDataRejected) {
    throw new Error('Invalid or incompatible cached data (cachedDataRejected)')
  }

  /*
  This part is based on:
  https://github.com/zertosh/v8-compile-cache/blob/7182bd0e30ab6f6421365cee0a0c4a8679e9eb7c/v8-compile-cache.js#L158-L178
  */

  function require (id: string) {
    return module.require(id)
  }
  require.resolve = function (request: any, options: any) {
    // @ts-ignore
    return Module._resolveFilename(request, module, false, options)
  }
  if (process.mainModule) {
    require.main = process.mainModule
  }

  // @ts-ignore
  require.extensions = Module._extensions
  // @ts-ignore
  require.cache = Module._cache

  const compiledWrapper = script.runInThisContext({
    filename: filename,
    lineOffset: 0,
    columnOffset: 0,
    displayErrors: true
  })

  const dirname = path.dirname(filename)

  const args = [module.exports, require, module, filename, dirname, process, global]

  return compiledWrapper.apply(module.exports, args)
}

/**
 * Add a loader file for a given .jsc file
 * @param {String} fileToLoad path of the .jsc file we're loading
 * @param {String} loaderFilename - optional pattern or name of the file to write - defaults to filename.loader.js. Patterns: "%" represents the root name of .jsc file.
 */
export function addLoaderFile (fileToLoad: string, loaderFilename?: string) {
  let loaderFilePath
  if (typeof loaderFilename === 'boolean' || loaderFilename === undefined || loaderFilename === '') {
    loaderFilePath = fileToLoad.replace('.jsc', '.loader.js')
  } else {
    loaderFilename = loaderFilename.replace('%', path.parse(fileToLoad).name)
    loaderFilePath = path.join(path.dirname(fileToLoad), loaderFilename)
  }
  const relativePath = path.relative(path.dirname(loaderFilePath), fileToLoad)
  const code = loaderCode(relativePath)
  fs.writeFileSync(loaderFilePath, code)
}

export function loaderCode (relativePath: string) {
  return `
    const bytenode = require('bytenode');
    require('./${relativePath}');
  `
};

// @ts-ignore
global.bytenode = {
  compileCode,
  compileFile,
  compileElectronCode,
  runBytecode,
  runBytecodeFile,
  addLoaderFile,
  loaderCode
}

// module.exports = global.bytenode
