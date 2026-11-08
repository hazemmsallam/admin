package com.eventticketing.admin.client.dto;

import java.time.Instant;
import java.util.List;
import java.util.Set;

public record EventResponse(
        Long id,
        String name,
        String description,
        String category,
        String imageUrl,
        String tagline,
        Boolean featured,
        Set<String> tags,
        Instant startAt,
        Instant endAt,
        String status,
        Integer maxCapacity,
        OrganizerResponse organizer,
        HallSummaryResponse hall,
        List<PricingResponse> pricing
) {
}
