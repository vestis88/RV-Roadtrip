import { describe, expect, it } from 'vitest'
import type { CountryBriefSection, Vehicle } from './schemas.js'
import {
  DEFAULT_COUNTRY_BRIEF_SECTIONS,
  countryGuideSectionDocId,
  stableHash,
  vehicleKey,
} from './countryBrief.js'

const VAN: Vehicle = {
  type: 'RV',
  weightKg: 3800,
  registeredAs: 'car',
  heightM: 3.1,
  lengthM: 7,
  fuel: 'diesel',
}
const TALLER: Vehicle = { ...VAN, heightM: 3.4 }

const vehicleDependent: CountryBriefSection = {
  id: 'speed-limits',
  title: 'Speed limits',
  brief: 'Limits for this weight.',
  dependsOnVehicle: true,
}
const countryOnly: CountryBriefSection = {
  id: 'camping-rules',
  title: 'Camping rules',
  brief: 'Rules for official campsites.',
  dependsOnVehicle: false,
}

describe('the default brief', () => {
  it('has unique section ids', () => {
    const ids = DEFAULT_COUNTRY_BRIEF_SECTIONS.map((section) => section.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('marks exactly the sections whose answer changes with the RV', () => {
    const vehicleScoped = DEFAULT_COUNTRY_BRIEF_SECTIONS.filter(
      (section) => section.dependsOnVehicle,
    ).map((section) => section.id)
    expect(vehicleScoped.sort()).toEqual(
      ['driving-rules', 'road-fees', 'speed-limits'].sort(),
    )
  })
})

describe('stableHash', () => {
  it('is deterministic, which is the whole point — the browser picks the key the backend wrote', () => {
    expect(stableHash('Rules for official campsites.')).toBe(
      stableHash('Rules for official campsites.'),
    )
  })

  it('separates different text', () => {
    expect(stableHash('a')).not.toBe(stableHash('b'))
  })
})

describe('countryGuideSectionDocId', () => {
  it('reuses one entry for a country-level section across different vehicles', () => {
    expect(
      countryGuideSectionDocId({ countryCode: 'NO', section: countryOnly, vehicle: VAN }),
    ).toBe(
      countryGuideSectionDocId({
        countryCode: 'NO',
        section: countryOnly,
        vehicle: TALLER,
      }),
    )
  })

  it('separates a vehicle-dependent section when the vehicle changes', () => {
    expect(
      countryGuideSectionDocId({
        countryCode: 'NO',
        section: vehicleDependent,
        vehicle: VAN,
      }),
    ).not.toBe(
      countryGuideSectionDocId({
        countryCode: 'NO',
        section: vehicleDependent,
        vehicle: TALLER,
      }),
    )
  })

  it('separates countries', () => {
    expect(
      countryGuideSectionDocId({ countryCode: 'NO', section: countryOnly, vehicle: VAN }),
    ).not.toBe(
      countryGuideSectionDocId({ countryCode: 'SE', section: countryOnly, vehicle: VAN }),
    )
  })

  // Editing what you asked for must not silently serve the answer to the
  // old question — and must not overwrite the entry other travelers share.
  it('separates an edited brief from the original', () => {
    const edited = { ...countryOnly, brief: 'Rules for official campsites, with dogs.' }
    expect(
      countryGuideSectionDocId({ countryCode: 'NO', section: countryOnly, vehicle: VAN }),
    ).not.toBe(
      countryGuideSectionDocId({ countryCode: 'NO', section: edited, vehicle: VAN }),
    )
  })

  it('ignores the title, which is only a label', () => {
    const renamed = { ...countryOnly, title: 'Campsites' }
    expect(
      countryGuideSectionDocId({ countryCode: 'NO', section: renamed, vehicle: VAN }),
    ).toBe(
      countryGuideSectionDocId({ countryCode: 'NO', section: countryOnly, vehicle: VAN }),
    )
  })
})

describe('vehicleKey', () => {
  it('ignores nothing that changes an answer', () => {
    expect(vehicleKey(VAN)).not.toBe(vehicleKey({ ...VAN, weightKg: 3000 }))
    expect(vehicleKey(VAN)).not.toBe(vehicleKey({ ...VAN, lengthM: 8 }))
    expect(vehicleKey(VAN)).not.toBe(vehicleKey({ ...VAN, fuel: 'electric' }))
  })

  it('treats an unset dimension as its own value, not as zero', () => {
    const noHeight: Vehicle = { ...VAN, heightM: undefined }
    expect(vehicleKey(noHeight)).not.toBe(vehicleKey({ ...VAN, heightM: 0.0001 }))
  })
})
