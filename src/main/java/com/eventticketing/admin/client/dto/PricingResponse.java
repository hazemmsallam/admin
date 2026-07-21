package com.eventticketing.admin.client.dto;

import java.math.BigDecimal;

public record PricingResponse(String seatType, BigDecimal price) {
}
