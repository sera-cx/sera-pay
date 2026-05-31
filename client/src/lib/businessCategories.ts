import type { AdvancedSelectGroup } from "@/components/AdvancedSelect";

export const BUSINESS_CATEGORY_GROUPS: AdvancedSelectGroup[] = [
  {
    label: "Food & Beverage",
    options: [
      { value: "Restaurant", label: "Restaurant", description: "Dine-in, casual dining, fine dining" },
      { value: "Cafe", label: "Cafe", description: "Coffee shop, brunch, tea room" },
      { value: "Hawker / Street Food", label: "Hawker / Street Food", description: "Stall, kiosk, night market" },
      { value: "Food Truck", label: "Food Truck", description: "Mobile food and drinks" },
      { value: "Bakery", label: "Bakery", description: "Bread, pastry, cake shop" },
      { value: "Dessert Shop", label: "Dessert Shop", description: "Ice cream, gelato, sweets" },
      { value: "Bubble Tea", label: "Bubble Tea", description: "Tea, juice, specialty drinks" },
      { value: "Bar / Pub", label: "Bar / Pub", description: "Bar, pub, lounge" },
      { value: "Catering", label: "Catering", description: "Events, packed meals, banquet" },
      { value: "Grocery / Convenience", label: "Grocery / Convenience", description: "Mini mart, grocery, daily goods" },
    ],
  },
  {
    label: "Retail & Shopping",
    options: [
      { value: "Retail", label: "Retail", description: "General retail store" },
      { value: "Fashion", label: "Fashion", description: "Clothing, shoes, accessories" },
      { value: "Beauty Retail", label: "Beauty Retail", description: "Cosmetics, skincare, fragrance" },
      { value: "Electronics", label: "Electronics", description: "Devices, gadgets, accessories" },
      { value: "Home & Furniture", label: "Home & Furniture", description: "Furniture, homeware, decor" },
      { value: "Sports & Outdoors", label: "Sports & Outdoors", description: "Fitness, outdoor, equipment" },
      { value: "Books / Stationery", label: "Books / Stationery", description: "Books, stationery, gifts" },
      { value: "Jewellery / Watches", label: "Jewellery / Watches", description: "Jewellery, watches, luxury items" },
      { value: "Pet Store", label: "Pet Store", description: "Pet supplies and grooming retail" },
      { value: "E-commerce", label: "E-commerce", description: "Online shop, marketplace seller" },
    ],
  },
  {
    label: "Beauty, Wellness & Personal Care",
    options: [
      { value: "Salon", label: "Salon", description: "Hair salon, colour, styling" },
      { value: "Barbershop", label: "Barbershop", description: "Cuts, shaves, grooming" },
      { value: "Nail Studio", label: "Nail Studio", description: "Manicure, pedicure, nail art" },
      { value: "Spa", label: "Spa", description: "Facial, body treatment, spa" },
      { value: "Massage", label: "Massage", description: "Massage and body therapy" },
      { value: "Fitness / Gym", label: "Fitness / Gym", description: "Gym, studio, personal training" },
      { value: "Yoga / Pilates", label: "Yoga / Pilates", description: "Classes and private sessions" },
      { value: "Wellness Clinic", label: "Wellness Clinic", description: "Nutrition, wellness, recovery" },
    ],
  },
  {
    label: "Health & Care",
    options: [
      { value: "Clinic", label: "Clinic", description: "Medical, GP, specialist clinic" },
      { value: "Dental", label: "Dental", description: "Dentist, orthodontics, oral care" },
      { value: "Pharmacy", label: "Pharmacy", description: "Medicine and health retail" },
      { value: "Optical", label: "Optical", description: "Eyewear, optometry, lenses" },
      { value: "Veterinary", label: "Veterinary", description: "Animal care and treatment" },
      { value: "Childcare", label: "Childcare", description: "Nursery, daycare, child services" },
      { value: "Elder Care", label: "Elder Care", description: "Caregiving and senior services" },
    ],
  },
  {
    label: "Professional & Local Services",
    options: [
      { value: "Services", label: "Services", description: "General service business" },
      { value: "Consulting", label: "Consulting", description: "Business, strategy, advisory" },
      { value: "Legal", label: "Legal", description: "Law firm, notary, legal services" },
      { value: "Accounting", label: "Accounting", description: "Bookkeeping, tax, audit" },
      { value: "Marketing / Design", label: "Marketing / Design", description: "Creative, branding, agency" },
      { value: "IT Services", label: "IT Services", description: "Software, support, cloud services" },
      { value: "Repair / Maintenance", label: "Repair / Maintenance", description: "Phone, appliance, general repair" },
      { value: "Cleaning", label: "Cleaning", description: "Home, office, commercial cleaning" },
      { value: "Laundry", label: "Laundry", description: "Laundry, dry cleaning, alteration" },
      { value: "Photography / Videography", label: "Photography / Videography", description: "Studio, event, production" },
    ],
  },
  {
    label: "Travel, Property & Vehicles",
    options: [
      { value: "Hotel / Accommodation", label: "Hotel / Accommodation", description: "Hotel, hostel, homestay" },
      { value: "Travel Agency", label: "Travel Agency", description: "Tours, tickets, travel services" },
      { value: "Transportation", label: "Transportation", description: "Taxi, shuttle, delivery, logistics" },
      { value: "Automotive", label: "Automotive", description: "Car wash, workshop, parts" },
      { value: "Real Estate", label: "Real Estate", description: "Agency, property management" },
      { value: "Rental / Leasing", label: "Rental / Leasing", description: "Equipment, vehicle, venue rental" },
    ],
  },
  {
    label: "Education, Events & Recreation",
    options: [
      { value: "Education", label: "Education", description: "School, tuition, training centre" },
      { value: "Online Course", label: "Online Course", description: "Digital course and coaching" },
      { value: "Events", label: "Events", description: "Event planner, venue, ticketing" },
      { value: "Arts / Entertainment", label: "Arts / Entertainment", description: "Gallery, performance, creative venue" },
      { value: "Recreation", label: "Recreation", description: "Games, activities, leisure" },
      { value: "Sports Club", label: "Sports Club", description: "Club, academy, training" },
    ],
  },
  {
    label: "Industrial & Other",
    options: [
      { value: "Construction", label: "Construction", description: "Contractor, renovation, trades" },
      { value: "Manufacturing", label: "Manufacturing", description: "Factory, production, assembly" },
      { value: "Wholesale", label: "Wholesale", description: "B2B supply and distribution" },
      { value: "Agriculture", label: "Agriculture", description: "Farm, forestry, fishing" },
      { value: "Nonprofit", label: "Nonprofit", description: "Charity, community, association" },
      { value: "Finance / Insurance", label: "Finance / Insurance", description: "Broker, agent, financial services" },
      { value: "Others", label: "Others", description: "Type a custom business category" },
    ],
  },
];

export function businessCategoryLabel(value: string) {
  return BUSINESS_CATEGORY_GROUPS.flatMap((group) => group.options).find((option) => option.value === value)?.label || value;
}