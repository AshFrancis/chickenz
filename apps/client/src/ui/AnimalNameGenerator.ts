import { Tutorial } from "../tutorial/Tutorial";

const ANIMALS = [
  "Moose",
  "Fox",
  "Cat",
  "Dog",
  "Lion",
  "Monkey",
  "Zebra",
  "Bear",
  "Wolf",
  "Eagle",
  "Hawk",
  "Otter",
  "Panda",
  "Koala",
  "Raven",
  "Shark",
  "Whale",
  "Tiger",
  "Cobra",
  "Viper",
  "Gecko",
  "Lemur",
  "Bison",
  "Crane",
  "Heron",
  "Finch",
  "Robin",
  "Llama",
  "Goose",
  "Duck",
  "Deer",
  "Frog",
  "Toad",
  "Crab",
  "Crow",
  "Dove",
  "Lynx",
  "Mole",
  "Moth",
  "Wasp",
  "Wren",
  "Swan",
  "Yak",
  "Newt",
  "Puma",
  "Seal",
  "Slug",
  "Mink",
];

export function generateAnimalName(): string {
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]!;
  const maxDigits = 7 - animal.length;
  const num = Math.floor(Math.random() * Math.pow(10, maxDigits));
  return `${animal}${num}`;
}

export function getOrCreateUsername(): string {
  const saved = localStorage.getItem("chickenz-username");
  if (saved) return saved;
  // New users get no name — they'll pick one after the tutorial.
  // Returning users who lost their username (cleared storage) get a random one.
  if (!Tutorial.shouldShow()) {
    const name = generateAnimalName();
    localStorage.setItem("chickenz-username", name);
    return name;
  }
  return "";
}
