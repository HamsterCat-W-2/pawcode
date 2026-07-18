import { describe, expect, it } from 'vitest'
import { isBrokenPipeError } from '../src/output/output-errors.js'

describe('output errors', () => {
  it('只把 EPIPE 识别为正常断管', () => {
    expect(isBrokenPipeError(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).toBe(true)
    expect(isBrokenPipeError(Object.assign(new Error('permission denied'), { code: 'EACCES' }))).toBe(false)
    expect(isBrokenPipeError('EPIPE')).toBe(false)
  })
})
