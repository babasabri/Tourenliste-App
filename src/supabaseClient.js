import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  // Ohne diese beiden Werte kann die App nicht mit der Datenbank sprechen.
  // Siehe .env.example - beide Werte kommen aus Supabase (Project Settings -> API)
  // und sind bewusst NICHT geheim (Publishable Key), im Gegensatz zum Secret Key,
  // der niemals in Browser-Code landen darf.
  console.error(
    "VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY fehlen. Bitte .env prüfen."
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey);
