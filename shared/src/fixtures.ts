import type {
  Activity,
  CountryGuide,
  LogEntry,
  PlanRequest,
  Restaurant,
  Trip,
  TripDay,
} from './schemas.js'

export const fixtureTrip: Trip = {
  meta: {
    name: 'Oslo to Rome 2026',
    shareCode: 'AB12CD',
    createdAt: '2026-06-01T10:00:00Z',
    version: 1,
  },
  settings: {
    startDate: '2026-07-10',
    endDate: '2026-08-02',
    startPoint: { name: 'Oslo, Norway', lat: 59.9139, lng: 10.7522 },
    endPoint: { name: 'Rome, Italy', lat: 41.9028, lng: 12.4964 },
    travelers: [
      { name: 'Bim', role: 'adult' },
      { name: 'Partner', role: 'adult' },
      { name: 'Kid', role: 'child', age: 8 },
    ],
    interests: ['castles', 'hiking', 'beaches'],
    preferredCountries: ['NO', 'DE', 'AT', 'IT'],
    restDayFrequency: 7,
    maxDriveHoursPerDay: 4,
    vehicle: {
      type: 'RV',
      weightKg: 3500,
      registeredAs: 'car',
      heightM: 2.9,
      lengthM: 6.5,
      widthM: 2.3,
      fuel: 'diesel',
    },
  },
  notes: {
    freeText: 'Kid has a peanut allergy. Prefer campsites with pools.',
    updatedAt: '2026-06-15T09:30:00Z',
  },
  planMeta: {
    status: 'ready',
    avgDriveMinutesPerDay: 180,
    totalKm: 2700,
    generatedAt: '2026-06-20T12:00:00Z',
  },
}

export const fixtureDay: TripDay = {
  index: 0,
  date: '2026-07-10',
  type: 'drive',
  overnight: {
    name: 'Lillehammer Camping',
    lat: 61.1153,
    lng: 10.4662,
    country: 'NO',
    campsiteSuggestion: 'Lillehammer Camping',
  },
  drive: {
    fromName: 'Oslo',
    toName: 'Lillehammer',
    distanceKm: 180,
    durationMin: 150,
    slot: 'morning',
  },
  summary: 'Easy first day north along the Mjøsa lake.',
}

export const fixtureActivity: Activity = {
  name: 'Maihaugen Open-Air Museum',
  category: 'museum',
  lat: 61.1147,
  lng: 10.4726,
  rating: 4.5,
  ratingCount: 1200,
  googleMapsUrl: 'https://maps.google.com/?q=Maihaugen',
  photoUrl: 'https://example.com/photo.jpg',
  blurb: 'A hidden-gem open-air museum the kids will love.',
  kidFriendly: true,
  status: 'suggested',
}

export const fixtureRestaurant: Restaurant = {
  name: 'Bryggerikjelleren',
  meal: 'dinner',
  lat: 61.1123,
  lng: 10.4661,
  rating: 4.3,
  ratingCount: 450,
  googleMapsUrl: 'https://maps.google.com/?q=Bryggerikjelleren',
  priceLevel: 2,
  cuisine: 'Norwegian',
  blurb: 'Cozy cellar restaurant near the river.',
  status: 'suggested',
}

export const fixtureCountryGuide: CountryGuide = {
  name: 'Norway',
  drivingRules: ['Headlights on at all times', 'Studded tires allowed Nov-Apr'],
  campingRules: ['Campsites require advance booking in July'],
  freeCampingRules: ['Allemannsretten allows free camping on uncultivated land'],
  roadFees: {
    summary: 'Toll roads around major cities, no nationwide vignette.',
    howToPay: 'AutoPASS, billed automatically via license plate.',
  },
  speedLimits: {
    urban: '50 km/h',
    rural: '80 km/h',
    motorway: '90 km/h for vehicles over 3,500 kg registered as car',
    notes: 'As of 2026-07-05, check local signage for RV-specific limits.',
  },
  lpgInfo: {
    adapterNeeded: 'Norwegian bayonet adapter',
    commonBrands: ['AGA', 'Kosan Gas'],
    tips: 'Refill stations are less common outside cities; carry a spare bottle.',
  },
  generatedAt: '2026-06-20T12:05:00Z',
}

export const fixtureLogEntry: LogEntry = {
  date: '2026-07-10',
  refType: 'activity',
  refPath: 'trips/trip1/days/2026-07-10/activities/place123',
  note: 'Kids loved the Viking exhibit.',
  createdAt: '2026-07-10T18:00:00Z',
}

export const fixturePlanRequest: PlanRequest = {
  tripId: 'trip1',
  kind: 'full',
  status: 'pending',
}
