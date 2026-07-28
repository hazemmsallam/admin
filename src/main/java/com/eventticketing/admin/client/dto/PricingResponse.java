package com.eventticketing.admin.client.dto;

import java.math.BigDecimal;

public record PricingResponse(Long sectionId, String sectionName, BigDecimal price) {
}
