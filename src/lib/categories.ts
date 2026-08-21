/**
 * categories.ts
 * Single source of truth for the 10 service categories.
 * Imported by registration UI, API validation, MCP server, and whitepages.
 */

export const CATEGORIES = [
  { slug: "delivery-errands", label: "Delivery & Errands" },
  { slug: "post-parcels", label: "Post & Parcels" },
  { slug: "home-maintenance", label: "Home Maintenance" },
  { slug: "garden-outdoors", label: "Garden & Outdoors" },
  { slug: "cleaning", label: "Cleaning" },
  { slug: "moving-hauling", label: "Moving & Hauling" },
  { slug: "pet-services", label: "Pet Services" },
  { slug: "photo-verification", label: "Photo & Verification" },
  { slug: "event-setup", label: "Event & Setup" },
  { slug: "personal-assistant", label: "Personal Assistant" },
] as const;

export type ServiceCategory = (typeof CATEGORIES)[number]["slug"];

const VALID_SLUGS = new Set<string>(CATEGORIES.map((c) => c.slug));

export const MIN_CATEGORIES = 1;
export const MAX_CATEGORIES = 2;

export function isValidCategory(s: string): s is ServiceCategory {
  return VALID_SLUGS.has(s);
}

export interface CategoryExample {
  task: string;
  description: string;
}

/**
 * How well a category's acceptance criteria can be checked by the deterministic
 * checker (ADR-0001 D5 / "Category applicability"). Tasks in weakly-checkable
 * categories resolve to the worker when no verdict is presented, which is why
 * they are candidates for value caps or exclusion from auto-booking (CC-074).
 */
export type CheckabilityTier = "strong" | "moderate" | "limited";

export const CHECKABILITY_LABELS: Record<CheckabilityTier, string> = {
  strong: "Checks strongly",
  moderate: "Checks moderately",
  limited: "Checks poorly",
};

/**
 * The standing rule behind every piiNote (ADR-0002 D7, CC-088): task content is
 * authored by the hiring agent and evidence is produced by the worker, and both
 * may contain third parties' personal information. Capture — and request — only
 * what the acceptance criteria actually require.
 */
export const EVIDENCE_PRIVACY_RULE =
  "Evidence may contain other people's personal information — faces, number plates, addresses. Capture only what the acceptance criteria require, and request only what the task needs.";

export interface CategoryDetail {
  slug: ServiceCategory;
  label: string;
  tagline: string;
  examples: CategoryExample[];
  disrupts: string;
  /** Deterministic-checkability tier per ADR-0001. */
  checkability: CheckabilityTier;
  /** What the checker can and cannot verify for this category (ADR-0001 D5). */
  checkabilityNote: string;
  /** Category-level PII guidance for agents authoring specs and workers
   * capturing evidence (ADR-0002 D7, CC-088). */
  piiNote: string;
}

export const CATEGORY_DETAILS: CategoryDetail[] = [
  {
    slug: "delivery-errands",
    label: "Delivery & Errands",
    tagline:
      "Pickup and drop-off tasks \u2014 food, supplies, forgotten items, prescriptions.",
    examples: [
      { task: "Restaurant pickup", description: "Collect a meal from a venue not on delivery platforms" },
      { task: "Grocery run", description: "Buy a specific list, photo-verify items" },
      { task: "Pharmacy pickup", description: "Collect a prescription or OTC items" },
      { task: "Forgotten item retrieval", description: "\u201CI left X at Y, go get it\u201D" },
    ],
    disrupts: "UberEats, DoorDash, Menulog markup. Plus the \u201Cit\u2019s not on any app\u201D gap.",
    checkability: "moderate",
    checkabilityNote:
      "Item photos, timestamps and receipt checks cover the handover, not the journey \u2014 route quality is unverifiable.",
    piiNote:
      "Specs carry a pickup address and an order name by necessity. Evidence should show the goods and the handover, not the recipient\u2019s face or documents.",
  },
  {
    slug: "post-parcels",
    label: "Post & Parcels",
    tagline:
      "Package lodgement, returns processing, document delivery \u2014 anything that requires walking into a post office or courier outlet.",
    examples: [
      { task: "AusPost / courier lodgement", description: "Drop a prepaid parcel at the counter" },
      { task: "eBay & marketplace returns", description: "Process a return with provided label" },
      { task: "Document delivery", description: "Physically deliver contracts or signed forms" },
      { task: "Prepaid envelope send", description: "Stuff, seal, lodge a pre-paid item" },
    ],
    disrupts: "Pack & Send fees, Sendle drop-off friction, eBay return hassle.",
    checkability: "moderate",
    checkabilityNote:
      "Lodgement receipts and tracking scans prove the drop-off happened, not that the contents were correct.",
    piiNote:
      "Parcel labels carry names and addresses. Evidence should show the lodgement — receipt, tracking scan — not close-ups of the label or anyone’s ID.",
  },
  {
    slug: "home-maintenance",
    label: "Home Maintenance",
    tagline:
      "Minor repairs and installations \u2014 the \u201Chire a hubby\u201D jobs that don\u2019t require a licensed trade.",
    examples: [
      { task: "Furniture assembly", description: "Flat-pack builds (IKEA, Bunnings, Kmart)" },
      { task: "Minor repairs", description: "Hang shelves, fix a door handle, patch a hole" },
      { task: "Appliance install", description: "Plug-in devices \u2014 no licensed electrical or plumbing" },
      { task: "Pressure wash", description: "Driveway, deck, fence \u2014 bring or use on-site gear" },
    ],
    disrupts: "Hire A Hubby, Fantastic Services, Airtasker handyman.",
    checkability: "limited",
    checkabilityNote:
      "Before/after photos prove presence at the site, not workmanship. A task with no machine-checkable criteria resolves to the worker.",
    piiNote:
      "Work happens inside a home — the highest-privacy location on the platform. Frame the work, never the occupants; evidence of a task that cannot be captured without people in frame should not be requested.",
  },
  {
    slug: "garden-outdoors",
    label: "Garden & Outdoors",
    tagline: "Lawn, garden, and outdoor maintenance \u2014 the Jim\u2019s Mowing tier.",
    examples: [
      { task: "Lawn mowing", description: "Standard residential mow and edge" },
      { task: "Garden tidy", description: "Weeding, mulching, green waste removal" },
      { task: "Hedge trimming", description: "Manual or powered hedge maintenance" },
      { task: "Outdoor assembly", description: "Trampoline, swing set, outdoor furniture builds" },
    ],
    disrupts: "Jim\u2019s Mowing, GreenAcres, local mowing franchises.",
    checkability: "moderate",
    checkabilityNote:
      "Before/after photo sets with EXIF GPS and timestamps cover extent-of-work well; quality of finish is subjective.",
    piiNote:
      "Exterior work, so bystander risk is low. Keep neighbours, passers-by and street numbers out of frame unless the criteria require them.",
  },
  {
    slug: "cleaning",
    label: "Cleaning",
    tagline:
      "Residential and light commercial cleaning \u2014 from regular cleans to end-of-lease.",
    examples: [
      { task: "Regular house clean", description: "Weekly / fortnightly standard clean" },
      { task: "End-of-lease clean", description: "Bond-back level deep clean" },
      { task: "BBQ / oven deep clean", description: "Specialist appliance cleaning" },
      { task: "Window washing", description: "Interior and exterior residential windows" },
    ],
    disrupts: "Jim\u2019s Cleaning, Absolute Domestics, Airtasker cleaning.",
    checkability: "limited",
    checkabilityNote:
      "Photos can show a surface was attended to, not that it is clean to a standard. End-of-lease checklists check better than \u201cregular clean\u201d prose.",
    piiNote:
      "Inside someone\u2019s home. Evidence shows the area cleaned \u2014 never occupants, documents, or anything that records how a person lives.",
  },
  {
    slug: "moving-hauling",
    label: "Moving & Hauling",
    tagline:
      "Small moves, tip runs, and heavy lifting \u2014 the \u201Cman with a van\u201D jobs.",
    examples: [
      { task: "Small furniture move", description: "Couch, fridge, or single-room relocations" },
      { task: "Tip run / dump drop", description: "Load up and dispose at the local transfer station" },
      { task: "Storage load/unload", description: "Pack or unpack a storage unit" },
      { task: "Hard rubbish collection", description: "Grab and dispose before council pickup" },
    ],
    disrupts: "Man With A Van, Airtasker removals, Gumtree labour hire.",
    checkability: "moderate",
    checkabilityNote:
      "Inventory before/after photos with GPS cover what moved and that it arrived; condition on arrival is disputable.",
    piiNote:
      "Home interiors and the entirety of someone’s belongings. Evidence is an inventory of items moved, not a record of a household.",
  },
  {
    slug: "pet-services",
    label: "Pet Services",
    tagline:
      "Dog walking, pet sitting, vet transport \u2014 tasks the pet owner can\u2019t get to.",
    examples: [
      { task: "Dog walking", description: "Scheduled walks, GPS-tracked route" },
      { task: "Pet sitting / check-in", description: "Feed, water, photo-verify at owner\u2019s home" },
      { task: "Vet transport", description: "Drive or carry pet to a booked appointment" },
      { task: "Pet supply pickup", description: "Collect food, meds, or gear from a pet store" },
    ],
    disrupts: "Mad Paws, Pawshake, rover-style platforms.",
    checkability: "limited",
    checkabilityNote:
      "GPS-tracked walks and timestamped check-in photos prove attendance, not the standard of care. One of the hardest categories to check mechanically.",
    piiNote:
      "Takes place in an owner’s home and around named animals, with vet paperwork attached. Evidence shows the animal and the task done — no photos of people, and vet documents only when the criteria require them.",
  },
  {
    slug: "photo-verification",
    label: "Photo & Verification",
    tagline:
      "Site documentation, condition reports, stock checks \u2014 the agent needs eyes on the ground.",
    examples: [
      { task: "Property condition photos", description: "Interior/exterior photo set for real estate or insurance" },
      { task: "Site documentation", description: "Construction progress, compliance evidence" },
      { task: "Price check / stock verification", description: "Walk in, confirm price or availability, photo proof" },
      { task: "Queue holding with proof", description: "Hold a spot, provide timestamped photo evidence" },
    ],
    disrupts: "Nothing directly \u2014 this category is agent-native. No franchise equivalent. Highest growth potential.",
    checkability: "strong",
    checkabilityNote:
      "The best-checking category on the platform: artefact counts, EXIF GPS radius, capture timestamps vs funding block, camera-model provenance and perceptual-hash comparison against reference images (ADR-0001 D5).",
    piiNote:
      "PII risk is inherent \u2014 this category exists to photograph places where third parties appear. Bystanders\u2019 faces and number plates the criteria do not require must not be in the evidence set. A \u201cphoto of anything at this address\u201d spec is a privacy defect, not a spec.",
  },
  {
    slug: "event-setup",
    label: "Event & Setup",
    tagline:
      "Physical setup, pack-down, signage, and distribution \u2014 event labour without the agency markup.",
    examples: [
      { task: "Event setup / pack-down", description: "Tables, chairs, marquees, AV gear" },
      { task: "Signage placement", description: "Install or remove signs at specified locations" },
      { task: "Flyer / sample distribution", description: "Geo-tagged proof of distribution" },
      { task: "Market stall assembly", description: "Build and break down a market or pop-up stall" },
    ],
    disrupts: "Airtasker events, Gumtree labour hire, staffing agencies.",
    checkability: "moderate",
    checkabilityNote:
      "Geo-tagged proof photos cover placement and pack-down; whether the setup was “right” is subjective.",
    piiNote:
      "Events mean crowds. Proof of distribution or setup should show the work, not identifiable attendees.",
  },
  {
    slug: "personal-assistant",
    label: "Personal Assistant",
    tagline:
      "The catch-all for errands that don\u2019t fit elsewhere \u2014 waiting, key handovers, returns, donations.",
    examples: [
      { task: "Wait for tradie / delivery", description: "Be present at a location for a scheduled arrival" },
      { task: "Key handover", description: "Collect or deliver keys to a specified person or lockbox" },
      { task: "Donation drop-off", description: "Take items to Salvos, Vinnies, or other charities" },
      { task: "In-store return / exchange", description: "Complete a return at a retail store with provided receipt" },
    ],
    disrupts: "Airtasker \u201Cother\u201D category. Also covers the \u201CI have money but no time\u201D market.",
    checkability: "limited",
    checkabilityNote:
      "\u201CWait for the tradie\u201D barely checks at all \u2014 presence can be timestamped, the waiting itself cannot. Weakest tier; expect value caps here (ADR-0001 open items).",
    piiNote:
      "Key handovers and named contacts (\u201Cask for Dave\u201D) put third parties\u2019 personal information in the spec itself. Evidence must not show keys together with anything that identifies an address or a person.",
  },
];

export function validateCategorySelection(
  categories: string[],
): { valid: true } | { valid: false; error: string } {
  if (!Array.isArray(categories)) {
    return { valid: false, error: "categories must be an array" };
  }
  if (categories.length < MIN_CATEGORIES) {
    return { valid: false, error: `Select at least ${MIN_CATEGORIES} category` };
  }
  if (categories.length > MAX_CATEGORIES) {
    return { valid: false, error: `Maximum ${MAX_CATEGORIES} categories allowed` };
  }
  const invalid = categories.filter((c) => !isValidCategory(c));
  if (invalid.length > 0) {
    return { valid: false, error: `Invalid categories: ${invalid.join(", ")}` };
  }
  return { valid: true };
}
