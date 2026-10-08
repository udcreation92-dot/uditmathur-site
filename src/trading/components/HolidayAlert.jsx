import { useState, useEffect } from "react";
import { api } from "../api";

export default function HolidayAlert() {
  const [holidays, setHolidays] = useState([]);

  useEffect(() => {
    api.getUpcomingHolidays(10).then(data => setHolidays(Array.isArray(data) ? data : [])).catch(() => {});
  }, []);

  if (holidays.length === 0) return null;

  return (
    <div className="bg-yellow-900/30 border border-yellow-800 rounded-lg px-4 py-2 mb-4 text-sm text-yellow-300">
      {holidays.map((h, i) => (
        <p key={i}>
          ⚠ Market holiday: <span className="font-semibold">{h.name}</span> on {h.date}
          {" "}({h.days_away === 0 ? "today" : h.days_away === 1 ? "tomorrow" : `in ${h.days_away} days`})
        </p>
      ))}
    </div>
  );
}
