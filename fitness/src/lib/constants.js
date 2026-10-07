export const MEALS = [
  { no: '1', name: 'Meal 1', eg: 'Breakfast', icon: '🌅', bg: 'bg-m1' },
  { no: '2', name: 'Meal 2', eg: 'Lunch', icon: '🍴', bg: 'bg-m2' },
  { no: '3', name: 'Meal 3', eg: 'Snack', icon: '🥣', bg: 'bg-m3' },
  { no: '4', name: 'Meal 4', eg: 'Dinner', icon: '🍽️', bg: 'bg-m4' },
]

export const MACROS = [
  { k: 'cal', label: 'Calories', unit: 'kcal', icon: '🔥' },
  { k: 'protein', label: 'Protein', unit: 'g', icon: '💪' },
  { k: 'carbs', label: 'Carbohydrates', unit: 'g', icon: '🌾' },
  { k: 'fat', label: 'Fats', unit: 'g', icon: '💧' },
  { k: 'fiber', label: 'Fiber', unit: 'g', icon: '🌿' },
]

export const TRAINING_TYPES = [
  { k: 'strength', label: 'Strength', icon: '🏋️', sets: true },
  { k: 'conditioning', label: 'Conditioning', icon: '🏃', sets: true },
  { k: 'active_rest', label: 'Active rest', icon: '🧘', sets: false },
  { k: 'rest', label: 'Rest', icon: '🛌', sets: false },
]

// The sheet's default weekly split, Monday first
export const DEFAULT_SPLIT = ['strength', 'conditioning', 'strength', 'active_rest', 'conditioning', 'strength', 'rest']

export const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v))
