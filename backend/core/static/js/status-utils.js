// Shared across pages: options + key mapping + predictive next
(function (w) {
  const STATUS_OPTIONS = [
    "Applied","Screening Booked","Screening Done","HM interview Booked","HM interview Done",
    "More interviews Booked","More interviews Done","Rejected with Filled","Rejected with Unfortunately", "Withdrew Applications",
    "Got Offer","Accepted Offer","Turned down Offer"
  ];

  function statusKey(label){
    if (!label) return "unset";
    const s = (""+label).toLowerCase().trim();
    if (s === "unset") return "unset";
    if (s === "applied") return "applied";
    if (s === "screening booked")       return "booked-screen";
    if (s === "hm interview booked")    return "booked-hm";
    if (s === "more interviews booked") return "booked-more";
    if (s === "screening done")         return "done-screen";
    if (s === "hm interview done")      return "done-hm";
    if (s === "more interviews done")   return "done-more";
    if (s === "got offer")              return "offer";
    if (s === "accepted offer")         return "accepted";
    if (s === "rejected with filled" || s === "rejected with unfortunately" || s === "turned down offer" || s === "Withdrew Applications" )
      return "finished";
    return "default";
  }

  function suggestNext(current){
    const s = (current || "").toLowerCase().trim();
    if (!s || s === "unset")                       return "Applied";
    if (s === "applied")                           return "Rejected with Unfortunately";
    if (s === "screening booked")                  return "Screening Done";
    if (s === "screening done")                    return "HM interview Booked";
    if (s === "hm interview booked")               return "HM interview Done";
    if (s === "hm interview done")                 return "Got Offer";
    if (s === "more interviews booked")            return "More interview Done";
    if (s === "more interviews done")              return "Got Offer";
    if (s === "got offer")                         return "Accepted Offer";
    if (s === "accepted offer")                    return "Turned down Offer";
    return "Applied";
  }

  w.Status = Object.freeze({ STATUS_OPTIONS, statusKey, suggestNext });
})(window);
