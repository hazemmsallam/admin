package com.eventticketing.admin.client.dto;

import java.math.BigDecimal;

public record PricingItem(String seatType, BigDecimal price) {
}
